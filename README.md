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

## Run as a systemd user service (background)

Runs the server in HTTP mode on loopback, so local MCP clients can connect over a URL instead of spawning their own process.

```bash
npm run build
./scripts/install-service.sh
```

The installer writes `~/.config/systemd/user/ollama-web-search-mcp.service` and creates `~/.config/ollama-web-search-mcp/env` (mode 600) if it does not exist. Put your key in the env file:

```bash
# ~/.config/ollama-web-search-mcp/env
OLLAMA_API_KEY=your_key
```

Then restart the service:

```bash
systemctl --user restart ollama-web-search-mcp
```

Status and logs:

```bash
systemctl --user status ollama-web-search-mcp
journalctl --user -u ollama-web-search-mcp -f
```

The server listens on `http://127.0.0.1:33011/mcp` and binds to loopback only — it is not reachable from other machines. To change the port, add `MCP_PORT=8080` to the env file and restart the service.

The service is a lightweight always-on wrapper: the MCP stack is lazy-loaded per request and evicted after `MCP_IDLE_MS` (default 60000) idle, so its memory footprint returns to the cold floor.

Uninstall (the env file is kept):

```bash
./scripts/install-service.sh --uninstall
```

## Connect agentic tools via URL

Clients that support HTTP transport can attach to the running service:

```json
{
  "mcpServers": {
    "ollama-web-search": {
      "type": "http",
      "url": "http://127.0.0.1:33011/mcp"
    }
  }
}
```

The stdio configuration shown above (command/args form) remains supported and unchanged; the URL form requires the service — or `node build/index.js --http` — to be running.