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
 * - URL suffixes: /collection/slug-k2KatQyCbK/recent -> k2KatQyCbK
 */
function extractId(input, baseUrl) {
  if (!input) return input;

  // 1. Direct UUID check (fast path)
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (uuidRegex.test(input)) return input;

  let url;
  try {
    // Only try to parse as URL if it looks like a path or full URL
    // Slugs like "title-SHORTID" or "title::SHORTID" should go to fallback
    if (input.startsWith("http") || input.startsWith("/") || input.includes("://")) {
      url = input.startsWith("http") ? new URL(input) : new URL(input, baseUrl);
    } else {
      throw new Error("Not a URL");
    }
  } catch {
    // Fallback if URL parsing fails or is skipped (e.g. just a slug or simple ID)
    const segments = input.split(/[ /]/).filter(Boolean);
    const last = segments[segments.length - 1];
    // Handle Outline slugs: TITLE-SHORTID or TITLE::SHORTID
    return last.split(/[ -]|::/).pop();
  }

  const pathParts = url.pathname.split("/").filter(Boolean);
  const ignoreSuffixes = ["recent", "starred", "drafts", "deleted"];

  // Filter out known view suffixes
  const meaningfulParts = pathParts.filter((p) => !ignoreSuffixes.includes(p));

  if (meaningfulParts.length === 0) return input;

  // Most Outline IDs are in the last meaningful segment of the path
  // e.g. /doc/title-SHORTID or /collection/title-SHORTID
  const lastPart = meaningfulParts[meaningfulParts.length - 1];

  // Handle slugs like "title-SHORTID" or legacy "title::SHORTID"
  return lastPart.split(/[ -]|::/).pop();
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
  collectionResolutionCache: new Map(),
  isResolved: false,
};

// Export for test resetting
export const getCONFIG = () => CONFIG;

const isUuid = (id) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    id,
  );

function primeCollectionResolutionCache(collections) {
  if (!Array.isArray(collections)) return;

  const uniqueNameToId = new Map();
  const duplicateNames = new Set();

  for (const collection of collections) {
    if (!collection?.id) continue;

    CONFIG.collectionResolutionCache.set(collection.id, collection.id);
    if (collection.urlId) {
      CONFIG.collectionResolutionCache.set(collection.urlId, collection.id);
    }

    const normalizedName = collection.name?.toLowerCase().trim();
    if (!normalizedName) continue;

    if (duplicateNames.has(normalizedName)) continue;

    if (uniqueNameToId.has(normalizedName)) {
      uniqueNameToId.delete(normalizedName);
      duplicateNames.add(normalizedName);
      continue;
    }

    uniqueNameToId.set(normalizedName, collection.id);
  }

  for (const [normalizedName, id] of uniqueNameToId.entries()) {
    CONFIG.collectionResolutionCache.set(`name:${normalizedName}`, id);
  }
}

/**
 * Ensures environment identifiers are resolved to full UUIDs.
 * Only runs once per server session.
 */
async function ensureResolved(outlineConfig) {
  if (CONFIG.isResolved) return;

  const baseUrl = outlineConfig.url;

  // Initialize from environment
  CONFIG.rawCollectionId = extractId(
    process.env.OUTLINE_DEFAULT_COLLECTION_ID,
    baseUrl,
  );
  CONFIG.rawParentDocumentId = extractId(
    process.env.OUTLINE_DEFAULT_PARENT_DOCUMENT_ID,
    baseUrl,
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
      primeCollectionResolutionCache(result.data);
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

function assertOutlineConfigured(config) {
  const missing = [];

  if (!config?.url) missing.push("OUTLINE_URL");
  if (!config?.token) missing.push("OUTLINE_API_TOKEN");

  if (missing.length === 0) return;

  throw new Error(
    `Outline MCP server is not configured. Missing required environment variable(s): ${missing.join(
      ", ",
    )}.`,
  );
}

function validateOneOf(args, fields, required = false) {
  const provided = fields.filter(
    (f) => args[f] !== undefined && args[f] !== null,
  );
  if (required && provided.length === 0) {
    throw new Error(`Exactly one of ${fields.join(", ")} must be provided.`);
  }
  if (provided.length > 1) {
    throw new Error(
      `Only one of ${fields.join(", ")} can be provided, but got: ${provided.join(", ")}`,
    );
  }
  return args[provided[0]];
}

// Tool Definitions with Defensive Schema Constraints
export const getTools = (defaultCollectionId) => [
  {
    name: "documents-list",
    description:
      "List documents in Outline. Never use curl or manual HTTP for Outline; use this tool. Accepts collection ID, URL, or name.",
    inputSchema: {
      type: "object",
      properties: {
        collectionId: {
          type: "string",
          description: "Canonical UUID or Short ID of the collection.",
        },
        collectionName: {
          type: "string",
          description: "Display name of the collection.",
        },
        collectionUrl: {
          type: "string",
          description: "Full Outline URL of the collection.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Optional max number of documents to return.",
        },
      },
    },
  },
  {
    name: "documents-get",
    description:
      "Get one Outline document. Never use curl or manual HTTP for Outline; use this tool. Returns metadata by default; set includeText=true only when full body is needed.",
    inputSchema: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description: "Canonical UUID or Short ID of the document.",
        },
        documentUrl: {
          type: "string",
          description: "Full Outline URL of the document.",
        },
        includeText: {
          type: "boolean",
          description: "Include full document text. Defaults to false to save tokens.",
        },
      },
      oneOf: [{ required: ["documentId"] }, { required: ["documentUrl"] }],
    },
  },
  {
    name: "collections-list",
    description:
      "List Outline collections. Never use curl or manual HTTP for Outline; use this tool to find canonical collection IDs or verify names.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "documents-search",
    description:
      "Search Outline documents by query. Never use curl or manual HTTP for Outline; use this tool. Optional collection filter accepts ID, URL, or name.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "The search query string.",
        },
        collectionId: {
          type: "string",
          description: "Optional canonical UUID or Short ID to narrow the search.",
        },
        collectionName: {
          type: "string",
          description: "Optional display name to narrow the search.",
        },
        collectionUrl: {
          type: "string",
          description: "Optional full Outline URL to narrow the search.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Optional max number of documents to return.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "documents-patch",
    description: `Surgically update an existing Outline document with search and replace.
Never use curl or manual HTTP for Outline; use this tool.
- PREFERRED for edits to existing documents. Do not switch to documents-upsert unless you truly need full-document replacement.
- The 'search' string MUST be unique within the document or the patch will fail.
- TIP: Include surrounding context such as a nearby header or sentence to make 'search' unique.
- Only matched regions change; the rest of the document stays byte-for-byte identical.
- Supports the same attachment handling as documents-upsert.`,
    inputSchema: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description: "Canonical UUID or Short ID of the document.",
        },
        documentUrl: {
          type: "string",
          description: "Full Outline URL of the document.",
        },
        patches: {
          type: "array",
          items: {
            type: "object",
            properties: {
              search: {
                type: "string",
                description:
                  "The exact literal text to find. MUST be unique in the document.",
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
                description: "Local file path; preferred for large files.",
              },
              name: {
                type: "string",
                description: "Filename; defaults to basename(path).",
              },
              contentType: {
                type: "string",
                description: "MIME type; guessed from path if omitted.",
              },
              content: {
                type: "string",
                description: "Base64 file content; use with name when not using path.",
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
            "Optional attachments. You MUST include any local files you want to upload here. Reference them in replace text with Markdown links (e.g., ![alt](filename)) or {{attachment:filename}}. They will be automatically uploaded and the URLs in the text replaced.",
        },
      },
      oneOf: [{ required: ["documentId"] }, { required: ["documentUrl"] }],
      required: ["patches"],
    },
  },
  {
    name: "documents-upsert",
    description: `Create or update Outline documents. Never use curl or manual HTTP for Outline; use this tool.
Prefer this for creating documents; prefer documents-patch for edits.
New documents are created in collection: ${defaultCollectionId || "the configured sandbox collection"}.`,
    inputSchema: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description: "Existing document UUID or Short ID to update.",
        },
        documentUrl: {
          type: "string",
          description: "Existing document URL to update.",
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
          description:
            "Markdown content. You MUST include any local files you want to upload in the 'attachments' parameter. Reference them using standard links ![alt](filename) or {{attachment:filename}} placeholders; these will be automatically replaced with Outline attachment URLs.",
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
        parentId: {
          type: "string",
          description:
            "Optional parent document UUID or Short ID for nesting. Must be in the sandbox collection.",
        },
        parentUrl: {
          type: "string",
          description: "Optional parent document URL for nesting.",
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "Local file path; preferred for large files.",
              },
              name: {
                type: "string",
                description: "Filename; defaults to basename(path).",
              },
              contentType: {
                type: "string",
                description: "MIME type; guessed from path if omitted.",
              },
              content: {
                type: "string",
                description: "Base64 file content; use with name when not using path.",
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
            "Optional attachments to upload. You MUST include any local files referenced in the text here for them to be automatically uploaded and replaced.",
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
    unified().use(remarkParse).parse(text);

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

function collectNodeText(node) {
  if (!node) return "";

  if (node.type === "text" || node.type === "inlineCode") {
    return node.value || "";
  }

  if (node.type === "image") {
    return node.alt || "";
  }

  if (!Array.isArray(node.children)) return "";

  return node.children.map((child) => collectNodeText(child)).join(" ");
}

function trimExcerpt(text, maxLength) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;

  const slice = normalized.slice(0, maxLength + 1);
  const sentenceCut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (sentenceCut >= Math.floor(maxLength * 0.6)) {
    return slice.slice(0, sentenceCut + 1).trim();
  }

  const wordCut = slice.lastIndexOf(" ");
  if (wordCut >= Math.floor(maxLength * 0.6)) {
    return slice.slice(0, wordCut).trim();
  }

  return normalized.slice(0, maxLength).trim();
}

function extractExcerptFromMarkdown(text, maxLength = 280) {
  if (typeof text !== "string" || text.trim().length === 0) return null;

  try {
    const tree = unified().use(remarkParse).parse(text);
    const candidates = [];

    for (const node of tree.children || []) {
      if (!node || ["heading", "thematicBreak", "code", "html"].includes(node.type)) {
        continue;
      }

      if (node.type === "paragraph" || node.type === "blockquote") {
        candidates.push(node);
        continue;
      }

      if (node.type === "list") {
        for (const item of node.children || []) {
          for (const child of item.children || []) {
            candidates.push(child);
          }
        }
      }
    }

    for (const candidate of candidates) {
      const plainText = collectNodeText(candidate);
      if (plainText.trim().length === 0) continue;
      return trimExcerpt(plainText, maxLength);
    }
  } catch {
    // Fall back to a raw prefix if markdown parsing fails.
  }

  return trimExcerpt(text, maxLength);
}

function summarizeDocument(document, { includeText = false, excerptLength } = {}) {
  if (!document) return null;

  const summary = {
    id: document.id,
    title: document.title,
    url: document.url,
    urlId: document.urlId,
    collectionId: document.collectionId,
    parentDocumentId: document.parentDocumentId,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    publishedAt: document.publishedAt,
  };

  if (includeText) {
    summary.text = document.text;
  } else if (excerptLength && typeof document.text === "string" && document.text.length > 0) {
    summary.excerpt = extractExcerptFromMarkdown(document.text, excerptLength);
  }

  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  );
}

function summarizeCollection(collection) {
  if (!collection) return null;

  return Object.fromEntries(
    Object.entries({
      id: collection.id,
      name: collection.name,
      urlId: collection.urlId,
      description: collection.description,
    }).filter(([, value]) => value !== undefined),
  );
}

function compactToolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

/**
 * Resolves a collection identifier (URL, ID, or Name) to a canonical UUID.
 * Handles ambiguity by returning an error string with suggestions.
 */
async function resolveCollectionId(input, outlineConfig) {
  if (!input) return null;

  const { url: baseUrl } = outlineConfig;

  // 1. Try direct extraction (UUID, URL, or Slug)
  const directId = extractId(input, baseUrl);

  // If it's a UUID, we're done
  const uuidRegex =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (uuidRegex.test(directId)) return directId;

  if (CONFIG.collectionResolutionCache.has(directId)) {
    return CONFIG.collectionResolutionCache.get(directId);
  }

  const searchName = input.toLowerCase().trim();
  const cachedNameMatch = CONFIG.collectionResolutionCache.get(`name:${searchName}`);
  if (cachedNameMatch) {
    return cachedNameMatch;
  }

  // 2. Fetch all collections to check for name matches
  const result = await callOutline("/api/collections.list", {}, outlineConfig);
  const collections = result.data || [];
  primeCollectionResolutionCache(collections);

  // 3. Try to find a collection by exact short ID/slug match first (canonical)
  const idMatch = collections.find(
    (c) => c.id === directId || c.urlId === directId,
  );
  if (idMatch) return idMatch.id;

  // 4. Try case-insensitive name match
  const nameMatches = collections.filter(
    (c) => c.name.toLowerCase().trim() === searchName,
  );

  if (nameMatches.length === 1) {
    return nameMatches[0].id;
  }

  if (nameMatches.length > 1) {
    const suggestions = nameMatches
      .map(
        (c) =>
          `- "${c.name}" [ID: ${c.id}]${c.description ? `: ${c.description}` : ""}`,
      )
      .join("\n");
    throw new Error(
      `Ambiguous collection name '${input}'. Found ${nameMatches.length} matches. Please use a specific collectionId from this list:\n${suggestions}`,
    );
  }

  // 5. Final fallback: If it wasn't a name, and we didn't find an ID match,
  // return the directId if it looks like a valid Outline identifier segment
  if (directId && directId.length >= 10) {
    return directId;
  }

  throw new Error(`Collection '${input}' not found.`);
}

// Handler logic extracted for testing
export async function handleCallTool(request, config) {
  const { name, arguments: args } = request.params;
  const { outlineUrl, outlineToken, logger } = config;

  const outlineConfig = { url: outlineUrl, token: outlineToken, logger };

  assertOutlineConfigured(outlineConfig);

  // Ensure lazy resolution of environment identifiers
  await ensureResolved(outlineConfig);

  const defaultCollectionId = CONFIG.resolvedCollectionId;
  const defaultParentDocumentId = CONFIG.resolvedParentDocumentId;

  switch (name) {
    case "documents-list": {
      const input = validateOneOf(args, [
        "collectionId",
        "collectionName",
        "collectionUrl",
      ]);
      const colId = await resolveCollectionId(input, outlineConfig);
      const result = await callOutline(
        "/api/documents.list",
        {
          ...(colId ? { collectionId: colId } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        },
        outlineConfig,
      );
      return compactToolResult({
        documents: (result.data || []).map((document) => summarizeDocument(document)),
      });
    }

    case "documents-get": {
      const input = validateOneOf(
        args,
        ["documentId", "documentUrl"],
        true, // required
      );
      const result = await callOutline(
        "/api/documents.info",
        {
          id: extractId(input, outlineUrl),
        },
        outlineConfig,
      );
      return compactToolResult({
        document: summarizeDocument(result.data, {
          includeText: args.includeText === true,
          excerptLength: args.includeText === true ? undefined : 280,
        }),
      });
    }

    case "collections-list": {
      const result = await callOutline(
        "/api/collections.list",
        {},
        outlineConfig,
      );
      return compactToolResult({
        collections: (result.data || []).map((collection) =>
          summarizeCollection(collection),
        ),
      });
    }

    case "documents-search": {
      const input = validateOneOf(args, [
        "collectionId",
        "collectionName",
        "collectionUrl",
      ]);
      const colId = await resolveCollectionId(input, outlineConfig);
      const result = await callOutline(
        "/api/documents.search",
        {
          query: args.query,
          ...(colId ? { collectionId: colId } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        },
        outlineConfig,
      );
      return compactToolResult({
        documents: (result.data || []).map((document) => summarizeDocument(document)),
      });
    }

    case "documents-patch": {
      const input = validateOneOf(
        args,
        ["documentId", "documentUrl"],
        true, // required
      );
      const argId = extractId(input, outlineUrl);
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
          // Find contextual snippets for each match to help the agent disambiguate
          const snippets = [];
          let currentPos = text.indexOf(search);
          let matchCount = 0;
          while (currentPos !== -1 && matchCount < 5) {
            matchCount++;
            const contextStart = currentPos;
            const contextEnd = Math.min(text.length, currentPos + search.length + 60);
            const snippet = text.slice(contextStart, contextEnd).replace(/\n/g, "\\n");
            snippets.push(`Match ${matchCount}: "${snippet}..."`);
            currentPos = text.indexOf(search, currentPos + 1);
          }

          throw new Error(
            `Patch failed: Search string is ambiguous and matches ${occurrences} times.\nMANDATE: To preserve Outline formatting, you MUST refine the 'search' string rather than switching to upsert.\nPlease include more surrounding context from one of these occurrences to make it unique:\n${snippets.join("\n")}`,
          );
        }
        // Using a function for replacement prevents '$' special character bugs
        text = text.replace(search, () => replace);
      }

      // Re-use attachment logic
      const result = await handleAttachmentUpsert(
        {
          ...args,
          text,
          title: docInfo.data.title,
          id: docInfo.data.id, // Use UUID for efficiency
        },
        outlineConfig,
        defaultCollectionId,
        false, // Not creating
      );

      return compactToolResult(result);
    }

    case "documents-upsert": {
      const inputId = validateOneOf(args, ["documentId", "documentUrl"]);
      const argId = extractId(inputId, outlineUrl);
      const creating = !argId;

      if (!defaultCollectionId) {
        throw new Error(
          "Server missing sandbox configuration. Please set OUTLINE_DEFAULT_COLLECTION_ID or OUTLINE_DEFAULT_PARENT_DOCUMENT_ID in your environment.",
        );
      }

      // Enforce Sandboxing: Verify document or parent belongs to the default collection
      let resolvedId = argId;
      if (creating) {
        const inputParent = validateOneOf(args, ["parentId", "parentUrl"]);
        const parentId =
          extractId(inputParent, outlineUrl) || defaultParentDocumentId;
        if (parentId && parentId !== defaultParentDocumentId) {
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
        resolvedId = docInfo.data.id; // Use UUID for efficiency
      }

      const result = await handleAttachmentUpsert(
        { ...args, id: resolvedId },
        outlineConfig,
        defaultCollectionId,
        creating,
      );

      return compactToolResult(result);
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
  const argId = extractId(args.id, outlineConfig.url);
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

          // 1. Replace explicit placeholders: {{attachment:filename}} -> redirect URL
          text = text.replaceAll(`{{attachment:${name}}}`, attachmentRedirectUrl);
          if (attachment.path) {
            text = text.replaceAll(
              `{{attachment:${attachment.path}}}`,
              attachmentRedirectUrl,
            );
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
      const inputParent = validateOneOf(args, ["parentId", "parentUrl"]);
      const parentId =
        extractId(inputParent, outlineConfig.url) || defaultParentDocumentId;
      if (parentId) {
        payload.parentDocumentId = parentId;
      }
      if (args.templateId) payload.templateId = args.templateId;
    } else {
      payload.id = argId;
    }

    // Final safety check must happen before the write so validation errors
    // don't return failure after Outline has already been mutated.
    validateMarkdown(text, logger);

    result = await callOutline(endpoint, payload, outlineConfig);
  } catch (error) {
    await cleanupUploadedAttachments();
    throw error;
  }

  // Include attachment IDs in the result for the user's reference
  return {
    operation: creating ? "create" : "update",
    document: summarizeDocument(result.data),
    ...(attachmentResults.length > 0 ? { attachments: attachmentResults } : {}),
  };
}

// MCP Server Initialization
const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

// Register Tool Listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
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
