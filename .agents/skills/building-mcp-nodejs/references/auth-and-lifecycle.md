# Authentication & Lifecycle for MCP Servers

## Lifecycle Management

MCP is a stateful protocol with three lifecycle phases. The initialization handshake must complete before any other messages are exchanged.

### Phase 1: Initialization

A capability negotiation handshake that establishes what both sides support.

**Client → Server: `initialize` request**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "roots": { "listChanged": true },
      "sampling": {},
      "elicitation": {}
    },
    "clientInfo": {
      "name": "example-client",
      "title": "Example Client",
      "version": "1.0.0"
    }
  }
}
```

**Server → Client: `initialize` response**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "tools": { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "prompts": { "listChanged": true },
      "logging": {}
    },
    "serverInfo": {
      "name": "example-server",
      "title": "Example Server",
      "version": "1.0.0"
    },
    "instructions": "Optional guidance for the client about using this server"
  }
}
```

**Client → Server: `notifications/initialized` notification**

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

### Version negotiation rules

- Client sends its latest supported `protocolVersion`
- Server responds with the same version if supported, otherwise returns its latest version
- If the client doesn't support the server's version, it should disconnect
- No other requests (except pings) should be sent before initialization completes
- Over HTTP, client must include `MCP-Protocol-Version: <version>` header on all subsequent requests

### Phase 2: Operation

Normal JSON-RPC message exchange within the negotiated capabilities. Both sides may send requests, responses, and notifications as permitted by their declared capabilities.

### Phase 3: Shutdown

No protocol-level shutdown message exists. Termination is transport-level:

| Transport | Shutdown sequence |
|-----------|------------------|
| stdio | Client closes stdin → sends SIGTERM → escalates to SIGKILL |
| HTTP | Client closes HTTP connection(s) and optionally sends DELETE with `Mcp-Session-Id` |

Implementations should set per-request timeouts and may reset the timeout on progress notifications.

## Capability Negotiation

Capabilities are declared during initialization and are fixed for the session. Only features declared in capabilities may be used.

### Client capabilities

| Capability | Description |
|-----------|-------------|
| `roots` | Client provides filesystem root directories. Supports `listChanged: true` for dynamic updates. |
| `sampling` | Client allows the server to request LLM completions via `sampling/createMessage`. |
| `elicitation` | Client allows the server to request user input via `elicitation/requestInput`. |
| `experimental` | Non-standard experimental features. Keys should follow `vendor.name` format. |

### Server capabilities

| Capability | Description |
|-----------|-------------|
| `tools` | Server exposes tools. Supports `listChanged: true` for `notifications/tools/list_changed`. |
| `resources` | Server exposes resources. Supports `subscribe: true` and `listChanged: true`. |
| `prompts` | Server exposes prompts. Supports `listChanged: true`. |
| `logging` | Server can send structured log messages. |
| `completions` | Server supports argument completion for prompts and resource templates. |
| `experimental` | Non-standard experimental features. |

## Notifications

Notifications are JSON-RPC messages with no `id` field and no expected response. They enable real-time updates.

### Server → Client notifications

| Notification | When | Prerequisite capability |
|-------------|------|------------------------|
| `notifications/tools/list_changed` | Tool list changed | `tools.listChanged: true` |
| `notifications/resources/list_changed` | Resource list changed | `resources.listChanged: true` |
| `notifications/resources/updated` | A resource's content changed | Client subscribed via `resources/subscribe` |
| `notifications/prompts/list_changed` | Prompt list changed | `prompts.listChanged: true` |
| `notifications/message` | Log message | `logging` capability |
| `notifications/progress` | Progress update on long-running request | Client sent `progressToken` in `_meta` |
| `notifications/cancelled` | Request was cancelled | Any |

### Client → Server notifications

| Notification | When |
|-------------|------|
| `notifications/initialized` | Client finished initialization |
| `notifications/cancelled` | Client cancelled a request |
| `notifications/roots/list_changed` | Client's root directories changed |

## OAuth 2.1 Authentication

Authorization is **optional** and only applies to HTTP transports. stdio servers should use environment variables for credentials instead.

MCP uses a subset of **OAuth 2.1** (IETF draft) with:
- OAuth 2.0 Authorization Server Metadata (RFC 8414)
- OAuth 2.0 Dynamic Client Registration (RFC 7591)
- OAuth 2.0 Protected Resource Metadata (RFC 9728)

### Roles

| MCP Role | OAuth Role |
|---------|-----------|
| MCP Server | Resource Server |
| MCP Client | OAuth Client |
| Authorization Server | Issues access tokens (may be co-located or separate) |

### Authentication flow

1. **Client sends unauthenticated request** → Server returns `HTTP 401` with `WWW-Authenticate` header containing `resource_metadata` URL
2. **Client fetches Protected Resource Metadata** from `/.well-known/oauth-protected-resource` → discovers `authorization_servers` list
3. **Client fetches Authorization Server Metadata** from `/.well-known/oauth-authorization-server` → discovers supported grant types, scopes, endpoints
4. **Dynamic Client Registration** — Client registers itself via `POST /register` (if AS supports it; clients SHOULD support this)
5. **PKCE authorization** — Client generates `code_challenge` + `code_verifier`, opens browser with authorization URL including `resource` parameter
6. **User authorizes** — Browser redirects back with authorization code
7. **Token exchange** — Client exchanges code for access token, including `code_verifier` and `resource`
8. **Authenticated requests** — Client includes `Authorization: Bearer <token>` on every HTTP request

### Key protocol rules

- **`resource` parameter (RFC 8707)** must be included in both authorization and token requests, identifying the MCP server's canonical URI
- Access tokens must use `Authorization: Bearer` header, never URI query strings
- Tokens must be included on every HTTP request
- Servers must validate token audience — reject tokens not issued for them
- **Token passthrough is forbidden** — servers must not forward client tokens to upstream APIs
- **PKCE is mandatory** for all clients (OAuth 2.1 Section 7.5.2)
- All AS endpoints must use HTTPS; redirect URIs must be `localhost` or HTTPS
- Short-lived access tokens recommended; refresh token rotation required for public clients
- Exact redirect URI validation mandatory
- `state` parameter should be used and verified

### Error handling

| HTTP Status | Meaning |
|------------|---------|
| 401 | Authorization required or token invalid/expired |
| 403 | Invalid scopes or insufficient permissions |
| 400 | Malformed authorization request |

### Implementation in Node.js

For servers using Streamable HTTP with Express, protect MCP endpoints with a Bearer token middleware:

```typescript
import { createMcpExpressApp } from "@modelcontextprotocol/express";

const app = createMcpExpressApp();

// Simple token validation (for real deployments, use a proper OAuth library)
app.use("/mcp", (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).set("WWW-Authenticate", 'Bearer resource_metadata="https://my-server.example.com/.well-known/oauth-protected-resource"').end();
  }
  const token = auth.slice(7);
  // Validate token: check audience, expiry, scopes
  // For production, use a library like express-oauth-server or jwks-rsa
  next();
});
```

For full OAuth 2.1 server implementation, consider libraries like `oidc-provider` (for the authorization server) and `express-openid-connect` (for the client side).

## Session Management (Streamable HTTP)

### Stateful sessions

When `sessionIdGenerator` is provided:

1. Server assigns a session ID on `InitializeResult` via the `Mcp-Session-Id` response header
2. Client must include `Mcp-Session-Id` on all subsequent requests
3. Server validates session ID — responds `400` if missing, `404` if expired
4. Server may terminate a session at any time (responds `404` to further requests)
5. Client should send `HTTP DELETE` with `Mcp-Session-Id` when it no longer needs the session

### Stateless mode

When `sessionIdGenerator` is `undefined`:

- No session tracking between requests
- Each request is independent
- Simpler to implement but no server-initiated notifications or streaming
- Best combined with `enableJsonResponse: true`

## Choosing Stateful vs Stateless

| Factor | Stateful | Stateless |
|--------|----------|-----------|
| Server-initiated notifications | Supported | Not supported |
| SSE streaming | Full support | Not recommended |
| Sampling / Elicitation | Works (needs session context) | Limited |
| Horizontal scaling | Requires sticky sessions or shared state | Easy |
| Complexity | Higher (session tracking) | Lower |