# Transport Setup for MCP Servers in Node.js

MCP supports two transport mechanisms: **stdio** (local process) and **Streamable HTTP** (remote/networked). The transport layer handles message framing and connection management while the data layer (JSON-RPC 2.0) stays the same across both.

## stdio Transport

The simplest transport. The client launches your server as a subprocess and communicates via stdin/stdout.

```typescript
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server running on stdio");
```

### How it works

- Client launches your server as a child process
- Server reads JSON-RPC messages from `stdin` (one per line, newline-delimited)
- Server writes JSON-RPC messages to `stdout`
- Server may write log/debug output to `stderr` (clients can capture or ignore it)
- Client closes `stdin` to signal shutdown, then escalates: SIGTERM → SIGKILL

### Rules

- **Never write to `stdout`** except MCP JSON-RPC messages. Any extra output corrupts the protocol. Use `console.error()` for all logging.
- Messages must be UTF-8 encoded, newline-delimited, and must not contain embedded newlines.
- No authentication is used with stdio — security comes from the local process boundary.

### Client configuration (Claude Desktop)

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/absolute/path/to/build/index.js"],
      "env": {
        "API_KEY": "optional-env-vars"
      }
    }
  }
}
```

### When to use stdio

- Local-only servers (filesystem access, local databases, shell commands)
- Integrating with desktop AI clients (Claude Desktop, Cursor)
- Maximum performance (no network overhead)
- Simplest setup — no HTTP server needed

## Streamable HTTP Transport

For remote servers accessible over HTTP. Supports multiple concurrent clients, optional SSE streaming, and session management.

### Basic setup (stateless, JSON-only)

```typescript
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "http";

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless — no sessions
  enableJsonResponse: true,     // JSON responses instead of SSE
});

const server = new McpServer({ name: "my-server", version: "1.0.0" });
await server.connect(transport);

const httpServer = createServer(transport.handleRequest);
httpServer.listen(3000);
console.error("MCP server listening on http://localhost:3000/mcp");
```

### Stateful setup with sessions

```typescript
import { randomUUID } from "node:crypto";

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => randomUUID(),
});
```

When `sessionIdGenerator` is provided, the server assigns a session ID during initialization (returned in the `Mcp-Session-Id` header). Clients must include this header on all subsequent requests.

### Express integration

Install the Express helper package:

```bash
npm install @modelcontextprotocol/express express
```

```typescript
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { randomUUID } from "node:crypto";

const app = createMcpExpressApp(); // Auto-enables DNS rebinding protection

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports[sessionId]) {
    await transports[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { transports[sid] = transport; },
    });
    transport.onclose = () => { delete transports[transport.sessionId]; };
    const server = new McpServer({ name: "my-server", version: "1.0.0" });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({ error: "Invalid request: no session and not initialization" });
});

function isInitializeRequest(body: any): boolean {
  return body?.method === "initialize";
}

const PORT = 3000;
app.listen(PORT, () => {
  console.error(`MCP server listening on http://localhost:${PORT}/mcp`);
});
```

### Hono integration

```bash
npm install @modelcontextprotocol/hono hono
```

```typescript
import { createMcpHonoApp } from "@modelcontextprotocol/hono";

const app = createMcpHonoApp();
// Similar pattern to Express — handle /mcp POST with session management
```

### How Streamable HTTP works

**Client → Server (POST):**
- Every JSON-RPC message from the client is a new HTTP POST to the MCP endpoint.
- Client sends `Accept: application/json, text/event-stream`.
- For requests: server responds with either `Content-Type: application/json` (single response) or `Content-Type: text/event-stream` (SSE stream for progressive results + notifications).
- For notifications/responses: server returns `202 Accepted` with no body.

**Server → Client (GET for listening):**
- Client may issue HTTP GET to the MCP endpoint to open an SSE stream for server-initiated messages (requests, notifications).
- Server returns either `Content-Type: text/event-stream` or `405 Method Not Allowed`.

### Session management

| Aspect | Behavior |
|--------|----------|
| **Session ID** | Server assigns via `Mcp-Session-Id` header on `InitializeResult` |
| **Client responsibility** | Must include `Mcp-Session-Id` on all subsequent requests |
| **Session termination** | Server responds `404` to expired sessions; client should re-initialize |
| **Explicit close** | Client sends HTTP DELETE with `Mcp-Session-Id` to terminate |
| **Multiple connections** | Client may have multiple SSE streams open simultaneously |

### Protocol version header

When using HTTP, the client must include `MCP-Protocol-Version: <version>` on all requests after initialization. The server should assume version `2025-03-26` if the header is absent (for backwards compatibility).

## DNS Rebinding Protection

Streamable HTTP servers are vulnerable to DNS rebinding attacks where a malicious website tricks a browser into connecting to a local MCP server.

### Protection levels

1. **Automatic (recommended):** Use `createMcpExpressApp()` or `createMcpHonoApp()` with host `127.0.0.1` or `localhost` — protection is enabled automatically.
2. **Binding to `0.0.0.0`:** You must provide an `allowedHosts` list explicitly:
   ```typescript
   const app = createMcpExpressApp({
     allowedHosts: ["my-server.example.com"],
   });
   ```
3. **Manual implementation:** Validate the `Origin` header on all incoming connections. Reject requests with unrecognized origins.

### Additional security measures

- Bind to `127.0.0.1` (not `0.0.0.0`) when running locally
- Implement proper authentication for all connections (see auth-and-lifecycle.md)
- Never expose local MCP servers to the public internet without auth

## Resumability (SSE stream recovery)

Servers may attach an `id` field to SSE events for resumability:

- If a client's SSE stream breaks, it reconnects with a `Last-Event-ID` header
- Server replays missed messages and resumes the stream from that point
- Event IDs must be globally unique within a session (or per-client if no sessions)
- Replay is per-stream — the server must not replay messages from a different stream

## SSE vs JSON-only mode

| Mode | When to use | Setting |
|------|------------|---------|
| **SSE streaming** | Long-running operations, progressive results, server-to-client notifications | `enableJsonResponse: false` (default) |
| **JSON-only** | Simple request/response, no streaming needed | `enableJsonResponse: true` |

## Backwards compatibility with HTTP+SSE (2024-11-05)

The Streamable HTTP transport replaces the deprecated HTTP+SSE transport. For backwards compatibility:

- **Servers:** Host both the old SSE+POST endpoints and the new MCP endpoint alongside each other.
- **Clients:** Try POST `InitializeRequest` to the URL first. If it fails (4xx), fall back to GET to open an SSE stream and look for an `endpoint` event.

## When to use Streamable HTTP

- Remote servers (Sentry, databases, APIs hosted elsewhere)
- Multi-client scenarios
- Need for OAuth/authentication
- Server needs to push notifications to clients proactively