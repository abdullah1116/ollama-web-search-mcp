#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_PATH="$REPO_ROOT/build/index.js"
TEMPLATE="$REPO_ROOT/systemd/ollama-web-search-mcp.service"
SERVICE_NAME="ollama-web-search-mcp.service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$SERVICE_NAME"
CONFIG_DIR="$HOME/.config/ollama-web-search-mcp"
ENV_FILE="$CONFIG_DIR/env"
MCP_PORT="${MCP_PORT:-33011}"

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl --user disable --now "$SERVICE_NAME" || true
  rm -f "$UNIT_PATH"
  systemctl --user daemon-reload || true
  echo "removed (env file kept)"
  exit 0
fi

if [[ ! -f "$TEMPLATE" ]]; then
  echo "error: unit template not found at $TEMPLATE" >&2
  exit 1
fi

NODE_BIN="$(command -v node)" || {
  echo "error: node not found on PATH; install Node.js 18 or later" >&2
  exit 1
}

if [[ ! -f "$SERVER_PATH" ]]; then
  echo "error: $SERVER_PATH not found — run \`npm run build\` first" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p -m 700 "$CONFIG_DIR"
  printf 'OLLAMA_API_KEY=\n' > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "warning: set OLLAMA_API_KEY in $ENV_FILE then: systemctl --user restart ollama-web-search-mcp" >&2
fi

if ! grep -qE '^[[:space:]]*(export[[:space:]]+)?OLLAMA_API_KEY[[:space:]]*=[[:space:]]*[^[:space:]]' "$ENV_FILE"; then
  echo "warning: OLLAMA_API_KEY is not set in $ENV_FILE; the service will start but API calls will fail" >&2
fi

escape_sed() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

mkdir -p "$UNIT_DIR"
sed -e "s|{{NODE_BIN}}|$(escape_sed "$NODE_BIN")|g" \
    -e "s|{{SERVER_PATH}}|$(escape_sed "$SERVER_PATH")|g" \
    -e "s|{{ENV_FILE}}|$(escape_sed "$ENV_FILE")|g" \
    "$TEMPLATE" > "$UNIT_PATH"

systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE_NAME"

echo
systemctl --user --no-pager -l status "$SERVICE_NAME" | head -5 || true
echo
echo "endpoint: http://127.0.0.1:${MCP_PORT}/mcp"
echo
cat <<JSON
{
  "mcpServers": {
    "ollama-web-search": {
      "type": "http",
      "url": "http://127.0.0.1:${MCP_PORT}/mcp"
    }
  }
}
JSON
