#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import express from "express";
import dotenv from "dotenv";
import { program } from "commander";
import pino from "pino";
import path from "path";
import os from "os";
import fs from "fs";
import mime from "mime-types";
import FormData from "form-data";

// Load environment variables
if (process.env.NODE_ENV !== "test") {
  // 1. Try local .env (default behavior)
  dotenv.config();

  // 2. Try global fallback in home directory (~/.outline-mcp.env)
  const globalConfigPath = path.join(os.homedir(), ".outline-mcp.env");
  if (fs.existsSync(globalConfigPath)) {
    dotenv.config({ path: globalConfigPath, override: true });
  }
}

// Setup Logger (Redacts token if it appears)
// Logs to stderr to avoid corrupting stdio transport
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      destination: 2, // Send logs to stderr
    },
  },
  redact: ["*.headers.Authorization", "*.token", "*.OUTLINE_API_TOKEN"],
});

/**
 * Extracts the identifier from a variety of inputs:
 * - UUIDs: 550e8400-e29b-41d4-a716-446655440000
 * - URL Paths: /doc/tutorial-setup-k2KatQyCbK -> k2KatQyCbK
 * - Full URLs: https://.../doc/title-k2KatQyCbK -> k2KatQyCbK
 */
function extractId(input) {
  if (!input) return input;
  // If it matches a UUID pattern, return it
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (uuidRegex.test(input)) return input;

  // Otherwise, extract the last alphanumeric segment (handling slugs and URLs)
  const parts = input.split(/[/ ]/).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  const idMatch = lastPart.match(/([a-zA-Z0-9]+)$/);
  return idMatch ? idMatch[1] : lastPart;
}

// Server Configuration
const SERVER_NAME = "outline-mcp-server";
const SERVER_VERSION = "1.0.0";

const DEFAULT_PORT = process.env.PORT || 3000;
const OUTLINE_URL = process.env.OUTLINE_URL;
const OUTLINE_API_TOKEN = process.env.OUTLINE_API_TOKEN;

// Global state for resolved UUIDs
const CONFIG = {
  rawCollectionId: null,
  rawParentDocumentId: null,
  resolvedCollectionId: null,
  resolvedParentDocumentId: null,
  isResolved: false,
};

// Export for test resetting
export const getCONFIG = () => CONFIG;

const isUuid = (id) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    id,
  );

/**
 * Ensures environment identifiers are resolved to full UUIDs.
 * Only runs once per server session.
 */
async function ensureResolved(outlineConfig) {
  if (CONFIG.isResolved) return;

  // Initialize from environment
  CONFIG.rawCollectionId = extractId(process.env.OUTLINE_DEFAULT_COLLECTION_ID);
  CONFIG.rawParentDocumentId = extractId(
    process.env.OUTLINE_DEFAULT_PARENT_DOCUMENT_ID,
  );

  // 1. Resolve Parent Document ID first (it contains the Collection ID)
  if (CONFIG.rawParentDocumentId) {
    if (isUuid(CONFIG.rawParentDocumentId)) {
      CONFIG.resolvedParentDocumentId = CONFIG.rawParentDocumentId;
    }

    logger.debug(
      { id: CONFIG.rawParentDocumentId },
      "Resolving parent document ID...",
    );
    // documents.info accepts short IDs natively and returns the full object
    try {
      const result = await callOutline(
        "/api/documents.info",
        { id: CONFIG.rawParentDocumentId },
        outlineConfig,
      );
      CONFIG.resolvedParentDocumentId = result.data.id;

      // Infer collection from parent if not explicitly set
      if (!CONFIG.resolvedCollectionId) {
        CONFIG.resolvedCollectionId = result.data.collectionId;
        logger.info(
          { collectionId: CONFIG.resolvedCollectionId },
          "Inferred sandbox collection from parent document.",
        );
      } else if (
        CONFIG.rawCollectionId &&
        isUuid(CONFIG.rawCollectionId) &&
        result.data.collectionId !== CONFIG.rawCollectionId
      ) {
        // If both provided, they MUST match
        throw new Error(
          `Configuration mismatch: Parent document belongs to collection ${result.data.collectionId}, but OUTLINE_DEFAULT_COLLECTION_ID is set to ${CONFIG.rawCollectionId}`,
        );
      }
    } catch (error) {
      throw new Error(
        `Failed to resolve OUTLINE_DEFAULT_PARENT_DOCUMENT_ID: ${error.message}`,
      );
    }
  }

  // 2. Resolve Collection ID if still needed
  if (CONFIG.rawCollectionId && !CONFIG.resolvedCollectionId) {
    if (isUuid(CONFIG.rawCollectionId)) {
      CONFIG.resolvedCollectionId = CONFIG.rawCollectionId;
    } else {
      logger.debug(
        { id: CONFIG.rawCollectionId },
        "Resolving collection short ID...",
      );
      const result = await callOutline(
        "/api/collections.list",
        {},
        outlineConfig,
      );
      const collection = result.data.find(
        (c) =>
          c.urlId === CONFIG.rawCollectionId ||
          c.id.endsWith(CONFIG.rawCollectionId),
      );
      if (!collection) {
        throw new Error(
          `Could not resolve collection: ${CONFIG.rawCollectionId}`,
        );
      }
      CONFIG.resolvedCollectionId = collection.id;
    }
  }

  CONFIG.isResolved = true;
  logger.info(
    {
      collectionId: CONFIG.resolvedCollectionId,
      parentId: CONFIG.resolvedParentDocumentId,
    },
    "Environment identifiers resolved.",
  );
}
const ATTACHMENT_UPLOAD_TIMEOUT_MS = Number(
  process.env.OUTLINE_ATTACHMENT_UPLOAD_TIMEOUT_MS || 30000,
);
const ATTACHMENT_CLEANUP_ON_FAILURE =
  process.env.OUTLINE_ATTACHMENT_CLEANUP_ON_FAILURE !== "false";

// Validate Credentials
if (!OUTLINE_URL || !OUTLINE_API_TOKEN) {
  logger.error("Missing OUTLINE_URL or OUTLINE_API_TOKEN in environment.");
  process.exit(1);
}

// Tool Definitions with Defensive Schema Constraints
export const getTools = (defaultCollectionId) => [
  {
    name: "documents-list",
    description:
      "Lists documents in the Outline wiki. Optionally filter by a specific collection.",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the collection to list documents from.",
        },
      },
    },
  },
  {
    name: "documents-get",
    description:
      "Retrieves a specific document by its ID. Returns the full content of the document.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          minLength: 1,
          description: "The ID (UUID) of the document to retrieve.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "documents-search",
    description:
      "Searches for documents by a query string. Returns a list of documents that match the query.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "The search query string.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "documents-upsert",
    description: `Creates or updates documents. 
IMPORTANT: This server is sandboxed. 
- All NEW documents will be created in collection: ${defaultCollectionId}.
- You can provide a 'parentDocumentId' to nest new documents, but the parent MUST be in the same collection.
- UPDATES are only permitted for existing documents already within this collection.`,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Existing document ID (UUID) to update. Omit to create a new document.",
        },
        title: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          description: "Title for the document (max 255 chars).",
        },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 100000,
          description: "Markdown content to store in the document (max 100KB).",
        },
        publish: {
          type: "boolean",
          description: "Whether to publish the document (default true).",
        },
        templateId: {
          type: "string",
          format: "uuid",
          description:
            "Optional template UUID to apply when creating a document.",
        },
        parentDocumentId: {
          type: "string",
          format: "uuid",
          description:
            "Optional parent document UUID for nesting. Must be in the sandbox collection.",
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Local file path to the attachment (preferred for large files like videos).",
              },
              name: {
                type: "string",
                description:
                  "The name of the file (e.g., video.mp4). Defaults to basename of path.",
              },
              contentType: {
                type: "string",
                description:
                  "The MIME type of the file. Will be guessed from path if omitted.",
              },
              content: {
                type: "string",
                description:
                  "The base64 encoded content of the file (alternative to path).",
              },
            },
          },
          description:
            "Optional list of attachments to upload and associate with the document. Use {{attachment:filename}} in the text to embed them.",
        },
      },
      required: ["title", "text"],
    },
  },
];

// Helper to call Outline API
export async function callOutline(endpoint, payload = {}, config = {}) {
  const { url: baseUrl, token, logger } = config;
  const url = new URL(endpoint, baseUrl).toString();
  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    if (logger) {
      logger.error({ status, message, endpoint }, "Outline API call failed.");
    }
    throw new Error(`Outline API Error: ${message}`, { cause: error });
  }
}

// Handler logic extracted for testing
export async function handleCallTool(request, config) {
  const { name, arguments: args } = request.params;
  const { outlineUrl, outlineToken, logger } = config;

  const outlineConfig = { url: outlineUrl, token: outlineToken, logger };

  // Ensure lazy resolution of environment identifiers
  await ensureResolved(outlineConfig);

  const defaultCollectionId = CONFIG.resolvedCollectionId;
  const defaultParentDocumentId = CONFIG.resolvedParentDocumentId;

  switch (name) {
    case "documents-list": {
      const result = await callOutline(
        "/api/documents.list",
        {
          collectionId: extractId(args?.collectionId),
        },
        outlineConfig,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "documents-get": {
      const result = await callOutline(
        "/api/documents.info",
        {
          id: extractId(args.id),
        },
        outlineConfig,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "documents-search": {
      const result = await callOutline(
        "/api/documents.search",
        {
          query: args.query,
        },
        outlineConfig,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "documents-upsert": {
      const argId = extractId(args.id);
      const creating = !argId;
      const endpoint = creating
        ? "/api/documents.create"
        : "/api/documents.update";

      if (!defaultCollectionId) {
        throw new Error(
          "Server missing sandbox configuration. Please set OUTLINE_DEFAULT_COLLECTION_ID or OUTLINE_DEFAULT_PARENT_DOCUMENT_ID in your environment.",
        );
      }

      // Enforce Sandboxing: Verify document or parent belongs to the default collection
      if (creating) {
        const parentId = extractId(args.parentDocumentId) || defaultParentDocumentId;
        if (parentId) {
          const parentInfo = await callOutline(
            "/api/documents.info",
            {
              id: parentId,
            },
            outlineConfig,
          );
          if (parentInfo.data.collectionId !== defaultCollectionId) {
            throw new Error(
              `Parent document ${parentId} is outside the sandbox collection.`,
            );
          }
        }
      } else {
        const docInfo = await callOutline(
          "/api/documents.info",
          {
            id: argId,
          },
          outlineConfig,
        );
        if (docInfo.data.collectionId !== defaultCollectionId) {
          throw new Error(
            `Document ${argId} is outside the sandbox collection and cannot be updated.`,
          );
        }
      }

      let text = args.text;
      const attachmentResults = [];
      const uploadedAttachmentIds = [];

      const cleanupUploadedAttachments = async () => {
        if (!ATTACHMENT_CLEANUP_ON_FAILURE || uploadedAttachmentIds.length === 0) {
          return;
        }

        for (const attachmentId of uploadedAttachmentIds) {
          try {
            await callOutline(
              "/api/attachments.delete",
              { id: attachmentId },
              outlineConfig,
            );
          } catch (cleanupError) {
            if (logger?.warn) {
              logger.warn(
                { attachmentId, error: cleanupError.message },
                "Failed to cleanup uploaded attachment after documents-upsert failure.",
              );
            }
          }
        }
      };

      let result;

      try {
        // Handle attachments
        if (args.attachments && args.attachments.length > 0) {
          for (const attachment of args.attachments) {
            try {
              let bufferOrStream;
              let size;
              let contentType = attachment.contentType;
              let name = attachment.name;

              if (attachment.path) {
                const fullPath = path.resolve(attachment.path);
                if (!fs.existsSync(fullPath)) {
                  throw new Error(`File not found: ${fullPath}`);
                }
                const stat = fs.statSync(fullPath);
                size = stat.size;
                bufferOrStream = fs.createReadStream(fullPath);
                if (!name) name = path.basename(fullPath);
                if (!contentType)
                  contentType =
                    mime.lookup(fullPath) || "application/octet-stream";
              } else if (attachment.content) {
                const buffer = Buffer.from(attachment.content, "base64");
                size = buffer.length;
                bufferOrStream = buffer;
                if (!name)
                  throw new Error("Name is required when using base64 content.");
                if (!contentType) contentType = "application/octet-stream";
              } else {
                throw new Error(
                  "Either 'path' or 'content' must be provided for each attachment.",
                );
              }

              const createResponse = await callOutline(
                "/api/attachments.create",
                {
                  name: name,
                  contentType: contentType,
                  size: size,
                  documentId: argId || undefined,
                },
                outlineConfig,
              );

              if (logger) {
                logger.debug({ createResponse }, "Outline attachments.create response");
              }

              const { uploadUrl, form, attachment: attachmentInfo } = createResponse.data || {};
              const id = attachmentInfo?.id;

              if (!id || !uploadUrl) {
                throw new Error(
                  "Outline attachments.create response missing required 'attachment.id' or 'uploadUrl'.",
                );
              }

              // Step 2: Upload to signed URL
              if (form) {
                // Multi-part upload (common for S3 backends)
                const formData = new FormData();
                for (const [key, value] of Object.entries(form)) {
                  formData.append(key, value);
                }
                formData.append("file", bufferOrStream, {
                  filename: name,
                  contentType: contentType,
                  knownLength: size,
                });

                await axios.post(uploadUrl, formData, {
                  headers: {
                    ...formData.getHeaders(),
                  },
                  maxBodyLength: Infinity,
                  maxContentLength: Infinity,
                  timeout: ATTACHMENT_UPLOAD_TIMEOUT_MS,
                });
              } else {
                // Direct PUT upload (common for local/GCS backends)
                await axios.put(uploadUrl, bufferOrStream, {
                  headers: {
                    "Content-Type": contentType,
                    "Content-Length": size,
                  },
                  maxBodyLength: Infinity,
                  maxContentLength: Infinity,
                  timeout: ATTACHMENT_UPLOAD_TIMEOUT_MS,
                });
              }

              uploadedAttachmentIds.push(id);
              attachmentResults.push({ name: name, id });

              // Helper to escape regex special characters
              const escapeRegExp = (string) =>
                string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

              const attachmentRedirectUrl = `/api/attachments.redirect?id=${id}`;

              // 1. Replace explicit placeholders: {{attachment:filename}} -> id
              text = text.replaceAll(`{{attachment:${name}}}`, id);
              if (attachment.path) {
                text = text.replaceAll(`{{attachment:${attachment.path}}}`, id);
              }

              /**
               * Regex Explanation:
               * (!\[.*?\])        - Group 1: The alt text part like ![image] or [link]
               * \(                - Opening parenthesis
               * \s*               - Optional leading whitespace
               * (FILENAME|PATH)   - The reference we want to replace
               * (\s+.*?)?         - Group 2: Optional title/caption starting with whitespace (e.g., " "title"")
               * \s*               - Optional trailing whitespace
               * \)                - Closing parenthesis
               */
              const replaceInMarkdown = (target, replacement, isImage) => {
                const prefix = isImage ? "!" : "";
                const regex = new RegExp(
                  `(${prefix}\\[.*?\\])\\((\\s*)${escapeRegExp(
                    target,
                  )}(\\s+.*?)?(\\s*)\\)`,
                  "g",
                );
                return text.replace(regex, `$1($2${replacement}$3$4)`);
              };

              // Replace in Images (using redirect URL)
              text = replaceInMarkdown(name, attachmentRedirectUrl, true);
              if (attachment.path) {
                text = replaceInMarkdown(attachment.path, attachmentRedirectUrl, true);
              }

              // Replace in Links (using redirect URL)
              text = replaceInMarkdown(name, attachmentRedirectUrl, false);
              if (attachment.path) {
                text = replaceInMarkdown(attachment.path, attachmentRedirectUrl, false);
              }

            } catch (error) {
              logger.error(
                {
                  attachment: attachment.name || attachment.path,
                  error: error.message,
                },
                "Failed to upload attachment",
              );
              throw new Error(
                `Failed to upload attachment '${
                  attachment.name || attachment.path
                }': ${error.message}`,
              );
            }
          }
        }

        const payload = {
          title: args.title,
          text: text,
          publish: args.publish ?? true,
        };

        if (creating) {
          payload.collectionId = defaultCollectionId;
          const parentId = extractId(args.parentDocumentId) || defaultParentDocumentId;
          if (parentId) {
            payload.parentDocumentId = parentId;
          }
          if (args.templateId) payload.templateId = args.templateId;
        } else {
          payload.id = argId;
        }

        result = await callOutline(endpoint, payload, outlineConfig);
      } catch (error) {
        await cleanupUploadedAttachments();
        throw error;
      }

      // Include attachment IDs in the result for the user's reference
      if (attachmentResults.length > 0) {
        result.attachments = attachmentResults;
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      throw new Error(`Tool '${name}' not found.`);
  }
}

// MCP Server Initialization
const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

// Register Tool Listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  await ensureResolved({ url: OUTLINE_URL, token: OUTLINE_API_TOKEN, logger });
  return {
    tools: getTools(CONFIG.resolvedCollectionId || CONFIG.rawCollectionId),
  };
});

// Register Tool Handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await handleCallTool(request, {
      outlineUrl: OUTLINE_URL,
      outlineToken: OUTLINE_API_TOKEN,
      logger,
    });
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error.message }],
    };
  }
});

// Transport Setup
program
  .name(SERVER_NAME)
  .version(SERVER_VERSION)
  .description("Outline Wiki MCP Server")
  .option("-t, --transport <type>", "Transport type: stdio or sse", "stdio")
  .option("-p, --port <number>", "Port for SSE transport", DEFAULT_PORT)
  .action(async (options) => {
    if (options.transport === "sse") {
      const app = express();
      let transport;

      app.get("/mcp", (req, res) => {
        transport = new SSEServerTransport("/mcp/messages", res);
        server.connect(transport);
      });

      app.post("/mcp/messages", (req, res) => {
        if (!transport)
          return res.status(400).send("No transport initialized.");
        transport.handleMessage(req, res);
      });

      app.listen(options.port, () => {
        logger.info(`SSE MCP server listening on port ${options.port}`);
        logger.info(`Discovery URL: http://localhost:${options.port}/mcp`);
      });
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info("Stdio MCP server initialized.");
    }
  });

if (import.meta.url === `file://${fs.realpathSync(process.argv[1])}`) {
  program.parse();
}
