# Ollama Web Search MCP Server

Expose Ollama's web search and web fetch APIs as MCP tools for AI assistants.

## Prerequisites

- Node.js 18 or later
- An Ollama API key (get one at https://ollama.com/settings/keys)

## Quick start

```bash
git clone <repo> && cd ollama-web-search-mcp
npm install
npm run build
OLLAMA_API_KEY=your_key node build/index.js
```

## Client configuration

### Claude Desktop / Cline

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ollama-web-search": {
      "command": "node",
      "args": ["/absolute/path/to/ollama-web-search-mcp/build/index.js"],
      "env": { "OLLAMA_API_KEY": "your_api_key_here" }
    }
  }
}
```

### Claude Code (CLI)

```bash
claude mcp add ollama-web-search -e OLLAMA_API_KEY=your_key -- node /absolute/path/to/ollama-web-search-mcp/build/index.js
```

### OpenAI Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.ollama-web-search]
command = "node"
args = ["/absolute/path/to/ollama-web-search-mcp/build/index.js"]
env = { OLLAMA_API_KEY = "your_api_key_here" }
```

### Goose

In the MCP server configuration UI:

- **Command:** `node`
- **Args:** `/absolute/path/to/ollama-web-search-mcp/build/index.js`
- **Environment:** `OLLAMA_API_KEY=your_api_key_here`

## Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `web_search` | `query` (string, required), `max_results` (number, optional, default 3, max 10) | Search the web and return results with title, URL, and content snippet |
| `web_fetch` | `url` (string, required, must be valid URL) | Fetch a web page by URL and return its title, content, and links |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OLLAMA_API_KEY` | Yes | Your Ollama API key for authentication |

## Python version

A Python implementation (`web-search-mcp.py`) is also included. Run it with `uv run web-search-mcp.py`.