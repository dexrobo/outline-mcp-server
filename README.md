# Outline Wiki MCP Server

This is a Model Context Protocol (MCP) server that provides access to an [Outline Wiki](https://www.getoutline.com/) instance. It allows AI agents to list, search, retrieve, and create/update documents.

## Features

- **Search and read your Outline knowledge base:** Agents can search by query, browse documents by collection, and fetch full document contents from Outline for grounded answers and follow-up work.
- **Create new pages in the right place by default:** New documents are always created inside a configured Outline collection, with optional nesting under a default parent document.
- **Update existing pages without crossing collection boundaries:** When editing an existing Outline doc, the server verifies that it belongs to the approved collection before allowing the write.
- **Work with Outline's document model:** The upsert flow supports standard Outline page fields like `title`, Markdown `text`, `publish`, `templateId`, and `parentDocumentId`.
- **Use one Outline workspace config everywhere:** The server supports a local `.env` file or a shared `~/.outline-mcp.env`, which is handy if you want multiple MCP clients pointing at the same wiki.

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
| `OUTLINE_DEFAULT_COLLECTION_ID` | UUID of the collection where new documents will be created |
| `OUTLINE_DEFAULT_PARENT_DOCUMENT_ID` | (Optional) UUID of a parent document to nest new documents under by default |
| `LOG_LEVEL` | Logging level (`info`, `debug`, `error`). Defaults to `info`. |

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

## Development

If you want to contribute or modify the server:

1. Clone the repo: `git clone https://github.com/dexrobo/outline-mcp-server.git`
2. Install dependencies: `npm install`
3. Run linting: `npm run lint`
4. Run formatting: `npm run format`
5. Run tests: `npm test`

## Security Notice

This server uses `pino` for logging with automatic redaction of `OUTLINE_API_TOKEN` and `Authorization` headers. Never share your environment variables or commit them to source control.
