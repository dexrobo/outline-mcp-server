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
import prettier from "prettier";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";

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
          minLength: 1,
          description:
            "Collection identifier to list from. Accepts UUID, short ID, or full Outline URL.",
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
          description:
            "Document identifier to retrieve. Accepts UUID, short ID, or full Outline URL.",
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
    name: "documents-patch",
    description: `Surgically updates an existing document using search and replace.
- Use this for small updates to existing documents to preserve the original formatting.
- Only the search regions are modified; the rest of the document remains byte-for-byte identical.
- Supports the same attachment handling as 'documents-upsert'.`,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          minLength: 1,
          description:
            "Document identifier to update. Accepts UUID, short ID, or full Outline URL.",
        },
        patches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              search: {
                type: "string",
                description: "The exact literal text to find.",
              },
              replace: {
                type: "string",
                description: "The text to replace it with.",
              },
            },
            required: ["search", "replace"],
          },
          description: "List of search/replace patches to apply.",
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
            oneOf: [
              {
                required: ["path"],
                not: { required: ["content"] },
              },
              {
                required: ["content", "name"],
                not: { required: ["path"] },
              },
            ],
          },
          description:
            "Optional list of attachments to upload and associate with the document. Use {{attachment:filename}} in the text to embed them.",
        },
      },
      required: ["id", "patches"],
    },
  },
  {
    name: "documents-upsert",
    description: `Creates or updates documents. 
IMPORTANT: This server is sandboxed. 
- All NEW documents will be created in collection: ${defaultCollectionId}.
- You can provide a 'parentDocumentId' to nest new documents, but the parent MUST be in the same collection.
- UPDATES are only permitted for existing documents already within this collection.
- New documents are automatically formatted with Prettier for consistency.`,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Existing document ID to update. Accepts UUID, short ID, or full Outline URL. Omit to create a new document.",
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
          minLength: 1,
          description:
            "Optional parent document ID for nesting. Accepts UUID, short ID, or full Outline URL. Must be in the sandbox collection.",
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
            oneOf: [
              {
                required: ["path"],
                not: { required: ["content"] },
              },
              {
                required: ["content", "name"],
                not: { required: ["path"] },
              },
            ],
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

function parseUploadError(error) {
  const status = error.response?.status;
  let detail = error.response?.data;
  if (Buffer.isBuffer(detail)) detail = detail.toString("utf8");
  if (typeof detail === "object" && detail !== null) {
    try {
      detail = JSON.stringify(detail);
    } catch {
      detail = String(detail);
    }
  }
  const detailText =
    typeof detail === "string" && detail.trim().length > 0
      ? detail.trim().slice(0, 500)
      : null;

  return [status ? `status=${status}` : null, detailText, error.message]
    .filter(Boolean)
    .join(" | ");
}

function appendPresignedFormFields(formData, formFields) {
  for (const [key, value] of Object.entries(formFields)) {
    if (value === undefined || value === null) {
      throw new Error(`Presigned form field '${key}' was empty.`);
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || typeof item === "object") {
          throw new Error(
            `Presigned form field '${key}' contained an unsupported value.`,
          );
        }
        formData.append(key, String(item));
      }
      continue;
    }

    if (typeof value === "object") {
      throw new Error(
        `Presigned form field '${key}' contained an unsupported object value.`,
      );
    }

    formData.append(key, String(value));
  }
}

function replaceMarkdownTargets(text, targets, replacement) {
  const targetSet = new Set((targets || []).filter(Boolean));
  if (targetSet.size === 0) return text;

  // Use remark-parse to find exactly where the links and images are
  const tree = unified().use(remarkParse).parse(text);
  const patches = [];

  visit(tree, ["link", "image"], (node) => {
    if (targetSet.has(node.url)) {
      // We have a match! We only want to replace the URL inside this specific node.
      // node.position contains start/end offsets for the whole [label](url)
      const start = node.position.start.offset;
      const end = node.position.end.offset;
      const originalNodeText = text.slice(start, end);

      // Now we find the URL's position within THIS specific node text.
      const searchUrl = node.url;
      let urlIdx = originalNodeText.indexOf(searchUrl);

      if (urlIdx !== -1) {
        patches.push({
          start: start + urlIdx,
          end: start + urlIdx + searchUrl.length,
          replacement,
        });
      }
    }
  });

  // Apply patches in reverse to maintain offsets
  patches.sort((a, b) => b.start - a.start);
  let out = text;
  for (const patch of patches) {
    out = out.slice(0, patch.start) + patch.replacement + out.slice(patch.end);
  }

  return out;
}

/**
 * Validates Markdown structure to prevent common LLM mistakes like unclosed blocks
 * or dangling placeholders.
 */
function validateMarkdown(text, logger) {
  try {
    const tree = unified().use(remarkParse).parse(text);

    // 1. Check for dangling attachment placeholders
    // (This catches LLM typos like {{attachment:mispelled.png}})
    const placeholderRegex = /{{attachment:[^}]+}}/g;
    const matches = text.match(placeholderRegex);
    if (matches && matches.length > 0) {
      throw new Error(
        `Validation failed: Found unreplaced attachment placeholder(s): ${matches.join(
          ", ",
        )}. This usually means the filename didn't match an uploaded attachment.`,
      );
    }
  } catch (error) {
    if (logger?.warn) {
      logger.warn({ error: error.message }, "Markdown validation failed.");
    }
    throw error;
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

    case "documents-patch": {
      const argId = extractId(args.id);
      if (!defaultCollectionId) {
        throw new Error(
          "Server missing sandbox configuration. Please set OUTLINE_DEFAULT_COLLECTION_ID or OUTLINE_DEFAULT_PARENT_DOCUMENT_ID in your environment.",
        );
      }

      // Fetch the original document
      const docInfo = await callOutline(
        "/api/documents.info",
        {
          id: argId,
        },
        outlineConfig,
      );

      // Enforce Sandboxing
      if (docInfo.data.collectionId !== defaultCollectionId) {
        throw new Error(
          `Document ${argId} is outside the sandbox collection and cannot be updated.`,
        );
      }

      let text = docInfo.data.text.replace(/\r\n/g, "\n");

      // Apply patches surgically
      for (const patch of args.patches) {
        const search = patch.search.replace(/\r\n/g, "\n");
        const replace = patch.replace.replace(/\r\n/g, "\n");

        const occurrences = text.split(search).length - 1;
        if (occurrences === 0) {
          throw new Error(
            `Patch failed: Could not find exact search string in document: "${search.slice(0, 50)}..."`,
          );
        }
        if (occurrences > 1) {
          throw new Error(
            `Patch failed: Search string is ambiguous and matches ${occurrences} times. Please provide more surrounding context to make it unique: "${search.slice(0, 50)}..."`,
          );
        }
        // Using a function for replacement prevents '$' special character bugs
        text = text.replace(search, () => replace);
      }

      // Re-use attachment logic
      const result = await handleAttachmentUpsert(
        { ...args, text, title: docInfo.data.title, id: argId },
        outlineConfig,
        defaultCollectionId,
        false, // Not creating
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    case "documents-upsert": {
      const argId = extractId(args.id);
      const creating = !argId;

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

      const result = await handleAttachmentUpsert(
        args,
        outlineConfig,
        defaultCollectionId,
        creating,
      );

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    default:
      throw new Error(`Tool '${name}' not found.`);
  }
}

/**
 * Common logic for handling attachments and document upsertion.
 */
async function handleAttachmentUpsert(
  args,
  outlineConfig,
  defaultCollectionId,
  creating,
) {
  const { logger } = outlineConfig;
  const argId = extractId(args.id);
  const defaultParentDocumentId = CONFIG.resolvedParentDocumentId;
  const endpoint = creating
    ? "/api/documents.create"
    : "/api/documents.update";

  let text = args.text;

  // Format new documents with Prettier for consistency
  if (creating) {
    try {
      text = await prettier.format(text, {
        parser: "markdown",
        proseWrap: "preserve",
        printWidth: 120,
      });
    } catch (prettierError) {
      if (logger?.warn) {
        logger.warn(
          { error: prettierError.message },
          "Prettier formatting failed for new document. Proceeding with original text.",
        );
      }
    }
  }

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

          const { uploadUrl, form, attachment: attachmentInfo } =
            createResponse.data || {};
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
            appendPresignedFormFields(formData, form);
            formData.append("file", bufferOrStream, {
              filename: name,
              contentType: contentType,
              knownLength: size,
            });

            try {
              await axios.post(uploadUrl, formData, {
                headers: {
                  ...formData.getHeaders(),
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                timeout: ATTACHMENT_UPLOAD_TIMEOUT_MS,
              });
            } catch (uploadError) {
              throw new Error(
                `Signed upload failed: ${parseUploadError(uploadError)}`,
              );
            }
          } else {
            // Direct PUT upload (common for local/GCS backends)
            try {
              await axios.put(uploadUrl, bufferOrStream, {
                headers: {
                  "Content-Type": contentType,
                  "Content-Length": size,
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
                timeout: ATTACHMENT_UPLOAD_TIMEOUT_MS,
              });
            } catch (uploadError) {
              throw new Error(
                `Signed upload failed: ${parseUploadError(uploadError)}`,
              );
            }
          }

          uploadedAttachmentIds.push(id);
          attachmentResults.push({ name: name, id });

          const attachmentRedirectUrl = `/api/attachments.redirect?id=${id}`;

          // 1. Replace explicit placeholders: {{attachment:filename}} -> id
          text = text.replaceAll(`{{attachment:${name}}}`, id);
          if (attachment.path) {
            text = text.replaceAll(`{{attachment:${attachment.path}}}`, id);
          }

          text = replaceMarkdownTargets(
            text,
            [name, attachment.path],
            attachmentRedirectUrl,
          );
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
      const parentId =
        extractId(args.parentDocumentId) || defaultParentDocumentId;
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

  // Final Safety Validation
  validateMarkdown(text, logger);

  // Include attachment IDs in the result for the user's reference
  if (attachmentResults.length > 0) {
    result.attachments = attachmentResults;
  }

  return result;
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
