# Outline Wiki MCP Server

This is a Model Context Protocol (MCP) server that provides access to an [Outline Wiki](https://www.getoutline.com/) instance. It allows AI agents to list, search, retrieve, and create/update documents.

## Features

- **Standardized:** Built with the official `@modelcontextprotocol/sdk`.
- **Multiple Transports:** Supports both `stdio` (local) and `SSE` (remote/Express) transports.
- **Secure:** Redacts sensitive tokens from logs and ensures credentials are never hardcoded.
- **Sandboxed Creation:** Forces new documents into a specific collection and parent page to prevent clutter.

## Configuration

The server looks for environment variables in the following order:
1.  **Process environment** (e.g., set via shell or CLI flags).
2.  **Local `.env` file** in the current working directory.
3.  **Global fallback file** at `~/.outline-mcp.env`.

### Environment Variable Reference

| Variable | Description |
|----------|-------------|
| `OUTLINE_URL` | Base URL of your Outline instance (e.g., `https://wiki.example.com`) |
| `OUTLINE_API_TOKEN` | Your Outline API token (requires write access for upsert) |
| `OUTLINE_DEFAULT_COLLECTION_ID` | UUID, URL, or Short ID of the target collection for new documents. Optional if Parent ID is set. |
| `OUTLINE_DEFAULT_PARENT_DOCUMENT_ID` | UUID, URL, or Short ID of the default parent document. The target collection is automatically inferred from this document if not explicitly set. |
| `LOG_LEVEL` | Logging level (`info`, `debug`, `error`). Defaults to `info`. |

### URL & Short ID Support

All ID fields—including environment variables and tool arguments—accept full Outline URLs (e.g., `https://.../doc/title-k2KatQyCbK`), short IDs (`k2KatQyCbK`), or standard UUIDs. The server automatically extracts and resolves these to the correct internal identifiers.

## Quick Start (Recommended)

To avoid repeating configuration across projects, you can create a single config file in your home directory:

### 1. Create a global config file

```bash
# Create the global config file
cat <<EOF > ~/.outline-mcp.env
OUTLINE_URL=https://your-wiki.getoutline.com
OUTLINE_API_TOKEN=your_api_token
OUTLINE_DEFAULT_COLLECTION_ID=collection_uuid
OUTLINE_DEFAULT_PARENT_DOCUMENT_ID=parent_doc_uuid
EOF
```

### 2. Add to your AI tool

Replace `<tool>` with your preferred CLI (**claude**, **codex**, or **gemini**):

```bash
<tool> mcp add outline npx -y github:dexrobo/outline-mcp-server
```

**Claude Desktop:**
Add this to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "outline": {
      "command": "npx",
      "args": ["-y", "github:dexrobo/outline-mcp-server"]
    }
  }
}
```

## Alternative Setup (CLI Flags)

If you prefer not to use a config file, replace `<tool>` with **claude**, **codex**, or **gemini**:

```bash
<tool> mcp add outline npx -y github:dexrobo/outline-mcp-server \
  --env OUTLINE_URL=... \
  --env OUTLINE_API_TOKEN=... \
  --env OUTLINE_DEFAULT_COLLECTION_ID=... \
  --env OUTLINE_DEFAULT_PARENT_DOCUMENT_ID=...
```

**Claude Desktop:**
```json
{
  "mcpServers": {
    "outline": {
      "command": "npx",
      "args": ["-y", "github:dexrobo/outline-mcp-server"],
      "env": {
        "OUTLINE_URL": "...",
        "OUTLINE_API_TOKEN": "...",
        "OUTLINE_DEFAULT_COLLECTION_ID": "...",
        "OUTLINE_DEFAULT_PARENT_DOCUMENT_ID": "..."
      }
    }
  }
}
```

### Call-outs & Caveats

- **API Token Scope:** The server operates with the permissions of the `OUTLINE_API_TOKEN`. It is highly recommended to use a service account or a token with restricted access if possible.
- **Sandboxing:** 
    - **Enforcement:** The server strictly enforces that all document creations and updates occur within the `OUTLINE_DEFAULT_COLLECTION_ID`.
    - **Creation:** The `documents-upsert` tool **forces** all new documents into the configured collection. The AI agent may specify a `parentDocumentId`; if omitted, it defaults to `OUTLINE_DEFAULT_PARENT_DOCUMENT_ID` (if set) or they may be created at the top level of the collection. Any specified parent must belong to the sandbox collection.
    - **Updates:** If an `id` is provided to `documents-upsert`, the server verifies the document belongs to the sandbox collection before allowing the update.
    - **Read Access:** `documents-list`, `documents-get`, and `documents-search` can access any document the API token can see.
- **Rate Limit:** Outline API calls are subject to the rate limits of your Outline instance.
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
- `documents-upsert`: Create or update documents (strictly sandboxed).
    - **Attachments:** Supports uploading images, PDFs, videos, and other files.
        - **Streaming:** Large files are streamed directly from local paths (use the `path` field).
        - **Base64:** Small files can be provided as base64 content.
        - **Markdown Integration:** You can link to attachments using standard Markdown syntax like `![Alt text](local/path/to/image.png)` or `[Download](filename.pdf)`. The server will automatically replace these with the correct attachment IDs.
        - **Explicit Placeholder:** Alternatively, use `{{attachment:filename}}` to get just the attachment ID.

## Development

If you want to contribute or modify the server:

1. Clone the repo: `git clone https://github.com/dexrobo/outline-mcp-server.git`
2. Install dependencies: `npm install`
3. Run linting: `npm run lint`
4. Run formatting: `npm run format`
5. Run tests: `npm test`

### Local Development & Testing

You can test the MCP server's end-to-end flow locally (including the standard MCP handshake) without a full MCP host using the provided smoke test utility:

```bash
# Verify the MCP protocol and tool routing locally
npm run test:mcp

# CI-safe wrapper with an outer hard timeout (45s)
npm run test:mcp:ci
```

This utility handles the standard JSON-RPC handshake, lists the available tools, and performs a test call to `documents-list` to ensure everything is wired correctly.

## Security Notice

This server uses `pino` for logging with automatic redaction of `OUTLINE_API_TOKEN` and `Authorization` headers. Never share your environment variables or commit them to source control.
