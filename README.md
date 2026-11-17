# ollama-web-search-mcp

MCP server exposing Ollama's `web_search` and `web_fetch` APIs as tools for AI assistants. One binary, two modes: **stdio** (default, spawned per client) or **HTTP** on loopback for clients that connect by URL — with a systemd user-service installer.

## Install

```bash
npm install -g ollama-web-search-mcp
```

From source (Node.js 18+):

```bash
git clone https://github.com/abdullah1116/ollama-web-search-mcp.git
cd ollama-web-search-mcp
npm install && npm run build
```

An [Ollama API key](https://ollama.com/settings/keys) is required — the server exits at startup without `OLLAMA_API_KEY`.

## Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `web_search` | `query` (string, required) · `max_results` (number, default 3, max 10) | Search the web; returns title, URL, content snippet |
| `web_fetch` | `url` (string, required) | Fetch a page; returns title, content (truncated at 50k chars), links |

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OLLAMA_API_KEY` | yes | — | Ollama API key |
| `MCP_PORT` | no | `33011` | HTTP mode: listen port (loopback only) |
| `MCP_IDLE_MS` | no | `60000` | HTTP mode: idle ms before the loaded code is evicted and memory returns to the cold floor |

## stdio mode

### Claude Desktop / Cline

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ollama-web-search": {
      "command": "ollama-web-search-mcp",
      "env": { "OLLAMA_API_KEY": "your_api_key_here" }
    }
  }
}
```

Running from source instead of a global install: `"command": "node", "args": ["/absolute/path/to/ollama-web-search-mcp/build/index.js"]`.

### Claude Code (CLI)

```bash
claude mcp add ollama-web-search -e OLLAMA_API_KEY=your_key -- ollama-web-search-mcp
```

### OpenAI Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.ollama-web-search]
command = "ollama-web-search-mcp"
env = { OLLAMA_API_KEY = "your_api_key_here" }
```

### Goose

Command `ollama-web-search-mcp`, environment `OLLAMA_API_KEY=your_api_key_here`.

## HTTP mode — systemd user service

An always-on wrapper on `http://127.0.0.1:33011/mcp` (loopback only): the MCP stack is lazy-loaded per request and evicted after `MCP_IDLE_MS` idle, so memory returns to the cold floor.

```bash
npm run build
./scripts/install-service.sh
```

The installer writes `~/.config/systemd/user/ollama-web-search-mcp.service` and creates `~/.config/ollama-web-search-mcp/env` (mode 600) if missing. Put your key there:

```bash
# ~/.config/ollama-web-search-mcp/env
OLLAMA_API_KEY=your_key
```

Restart and watch logs:

```bash
systemctl --user restart ollama-web-search-mcp
journalctl --user -u ollama-web-search-mcp -f
```

Change the port with `MCP_PORT=8080` in the env file. Uninstall (env file kept):

```bash
./scripts/install-service.sh --uninstall
```

### Connect an agentic tool via URL

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

Requires the service (or `node --expose-gc build/index.js --http`) to be running. The stdio configuration keeps working unchanged.

## License

MIT
