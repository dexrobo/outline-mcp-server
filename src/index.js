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

// Load environment variables
// 1. Try local .env (default behavior)
dotenv.config();

// 2. Try global fallback in home directory (~/.outline-mcp.env)
const globalConfigPath = path.join(os.homedir(), ".outline-mcp.env");
if (fs.existsSync(globalConfigPath)) {
  dotenv.config({ path: globalConfigPath });
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

// Server Configuration
const SERVER_NAME = "outline-mcp-server";
const SERVER_VERSION = "1.0.0";

const DEFAULT_PORT = process.env.PORT || 3000;
const OUTLINE_URL = process.env.OUTLINE_URL;
const OUTLINE_API_TOKEN = process.env.OUTLINE_API_TOKEN;
const DEFAULT_COLLECTION_ID = process.env.OUTLINE_DEFAULT_COLLECTION_ID;
const DEFAULT_PARENT_DOCUMENT_ID =
  process.env.OUTLINE_DEFAULT_PARENT_DOCUMENT_ID;

// Resolved collection ID (lazily populated)
let resolvedCollectionId = null;

// Helper to resolve collection slug to UUID if needed
async function getResolvedCollectionId() {
  if (resolvedCollectionId) return resolvedCollectionId;
  if (!DEFAULT_COLLECTION_ID) return null;

  // Simple UUID check
  const isUUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      DEFAULT_COLLECTION_ID,
    );

  if (isUUID) {
    resolvedCollectionId = DEFAULT_COLLECTION_ID;
    return resolvedCollectionId;
  }

  // If it's a slug, resolve it via the API
  try {
    const result = await callOutline("/api/collections.info", {
      id: DEFAULT_COLLECTION_ID,
    });
    resolvedCollectionId = result.data.id;
    logger.info(
      { slug: DEFAULT_COLLECTION_ID, uuid: resolvedCollectionId },
      "Resolved sandbox collection slug to UUID.",
    );
    return resolvedCollectionId;
  } catch (error) {
    logger.warn(
      { slug: DEFAULT_COLLECTION_ID, error: error.message },
      "Failed to resolve collection slug to UUID. Sandbox comparisons may fail.",
    );
    // Fallback to original value
    return DEFAULT_COLLECTION_ID;
  }
}

// Validate Credentials
if (!OUTLINE_URL || !OUTLINE_API_TOKEN) {
  logger.error("Missing OUTLINE_URL or OUTLINE_API_TOKEN in environment.");
  process.exit(1);
}

// Tool Definitions with Defensive Schema Constraints
const getTools = () => [
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
- All NEW documents will be created in collection: ${DEFAULT_COLLECTION_ID}.
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
      },
      required: ["title", "text"],
    },
  },
];

// Helper to call Outline API
async function callOutline(endpoint, payload = {}) {
  const url = new URL(endpoint, OUTLINE_URL).toString();
  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${OUTLINE_API_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const message = error.response?.data?.message || error.message;
    logger.error({ status, message, endpoint }, "Outline API call failed.");
    throw new Error(`Outline API Error: ${message}`, { cause: error });
  }
}

// MCP Server Initialization
const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

// Register Tool Listing
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getTools(),
}));

// Register Tool Handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "documents-list": {
        const result = await callOutline("/api/documents.list", {
          collectionId: args?.collectionId,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "documents-get": {
        const result = await callOutline("/api/documents.info", {
          id: args.id,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "documents-search": {
        const result = await callOutline("/api/documents.search", {
          query: args.query,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "documents-upsert": {
        const creating = !args.id;
        const endpoint = creating
          ? "/api/documents.create"
          : "/api/documents.update";

        if (!DEFAULT_COLLECTION_ID) {
          throw new Error(
            "Server missing OUTLINE_DEFAULT_COLLECTION_ID for sandboxing.",
          );
        }

        const sandboxId = await getResolvedCollectionId();

        // Enforce Sandboxing: Verify document or parent belongs to the default collection
        if (creating) {
          const parentId = args.parentDocumentId || DEFAULT_PARENT_DOCUMENT_ID;
          if (parentId) {
            const parentInfo = await callOutline("/api/documents.info", {
              id: parentId,
            });
            if (parentInfo.data.collectionId !== sandboxId) {
              throw new Error(
                `Parent document ${parentId} is outside the sandbox collection (sandbox: ${sandboxId}).`,
              );
            }
          }
        } else {
          const docInfo = await callOutline("/api/documents.info", {
            id: args.id,
          });
          if (docInfo.data.collectionId !== sandboxId) {
            throw new Error(
              `Document ${args.id} is outside the sandbox collection (sandbox: ${sandboxId}) and cannot be updated.`,
            );
          }
        }

        const payload = {
          title: args.title,
          text: args.text,
          publish: args.publish ?? true,
        };

        if (creating) {
          payload.collectionId = sandboxId;
          const parentId = args.parentDocumentId || DEFAULT_PARENT_DOCUMENT_ID;
          if (parentId) {
            payload.parentDocumentId = parentId;
          }
          if (args.templateId) payload.templateId = args.templateId;
        } else {
          payload.id = args.id;
        }

        const result = await callOutline(endpoint, payload);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        throw new Error(`Tool '${name}' not found.`);
    }
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

if (process.env.NODE_ENV !== "test") {
  program.parse();
}
