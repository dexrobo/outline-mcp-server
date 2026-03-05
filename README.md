# Outline Wiki MCP Server

This is a Model Context Protocol (MCP) server that provides access to an [Outline Wiki](https://www.getoutline.com/) instance. It allows AI agents to list, search, retrieve, and create/update documents.

## Features

- **Standardized:** Built with the official `@modelcontextprotocol/sdk`.
- **Multiple Transports:** Supports both `stdio` (local) and `SSE` (remote/Express) transports.
- **Secure:** Redacts sensitive tokens from logs and ensures credentials are never hardcoded.
- **Sandboxed Creation:** Forces new documents into a specific collection and parent page to prevent clutter.

## Quick Start (Claude Desktop)

To use this server with Claude Desktop, add it to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "outline": {
      "command": "npx",
      "args": ["-y", "github:dexrobo/outline-mcp-server"],
      "env": {
        "OUTLINE_URL": "https://your-wiki.getoutline.com",
        "OUTLINE_API_TOKEN": "your_api_token",
        "OUTLINE_DEFAULT_COLLECTION_ID": "collection_uuid",
        "OUTLINE_DEFAULT_PARENT_DOCUMENT_ID": "parent_doc_uuid"
      }
    }
  }
}
```

## Configuration

The server requires the following environment variables.

| Variable | Description |
|----------|-------------|
| `OUTLINE_URL` | Base URL of your Outline instance (e.g., `https://wiki.example.com`) |
| `OUTLINE_API_TOKEN` | Your Outline API token (requires write access for upsert) |
| `OUTLINE_DEFAULT_COLLECTION_ID` | UUID of the collection where new documents will be created |
| `OUTLINE_DEFAULT_PARENT_DOCUMENT_ID` | UUID of the parent document under which new documents will be nested |
| `LOG_LEVEL` | Logging level (`info`, `debug`, `error`). Defaults to `info`. |

### Call-outs & Caveats

- **API Token Scope:** The server operates with the permissions of the `OUTLINE_API_TOKEN`. It is highly recommended to use a service account or a token with restricted access if possible.
- **Sandboxing:** 
    - **Creation:** The `documents-upsert` tool **forces** all new documents into the `OUTLINE_DEFAULT_COLLECTION_ID` as children of `OUTLINE_DEFAULT_PARENT_DOCUMENT_ID`. This prevents the AI from creating top-level documents or scattering them across your wiki.
    - **Updates:** If an `id` is provided to `documents-upsert`, the server will attempt to update *that specific document*. The sandbox does not restrict updates to documents within the default collection; it depends on the API token's access.
    - **Read Access:** `documents-list`, `documents-get`, and `documents-search` can access any document the API token can see.
- **Rate Limiting:** Outline API calls are subject to the rate limits of your Outline instance.
- **No Deletion:** For security, this MCP server does not currently expose any deletion tools.

## Usage

### Local (via npx)

You can run the server directly using `npx`:

```bash
OUTLINE_URL=... OUTLINE_API_TOKEN=... npx github:dexrobo/outline-mcp-server
```

### Remote (SSE / HTTP)

Start the server in SSE mode (useful for remote deployments):

```bash
OUTLINE_URL=... OUTLINE_API_TOKEN=... npx github:dexrobo/outline-mcp-server --transport sse --port 3000
```

The discovery URL will be `http://localhost:3000/mcp`.

## Available Tools

- `documents-list`: List documents in a collection.
- `documents-get`: Retrieve full document content by ID.
- `documents-search`: Search for documents by query string.
- `documents-upsert`: Create or update documents (creation is sandboxed).

## Development

If you want to contribute or modify the server:

1. Clone the repo: `git clone https://github.com/dexrobo/outline-mcp-server.git`
2. Install dependencies: `npm install`
3. Start in dev mode: `npm run dev`

## Security Notice

This server uses `pino` for logging with automatic redaction of `OUTLINE_API_TOKEN` and `Authorization` headers. Never share your environment variables or commit them to source control.
