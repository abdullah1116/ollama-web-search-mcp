# Plan: Ollama Web Search MCP Server (Node.js/TypeScript)

## Context & Problem Statement

**Current state:** A Python MCP server (`web-search-mcp.py`) exists that exposes Ollama's `web_search` and `web_fetch` APIs as MCP tools. It uses the `ollama` Python SDK and supports both FastMCP and a low-level Server fallback.

**Problem:** The Python implementation has several weaknesses:
- Zero error handling — API failures crash the server or return unstructured errors
- No request timeout — a hung Ollama API call blocks the entire MCP server
- No response size limits — `web_fetch` can return megabytes of content, blowing LLM context windows
- `OLLAMA_API_KEY` is not validated at startup — failures only surface at first tool call
- No logging — impossible to debug issues
- The dual-path (FastMCP vs low-level) adds complexity for no practical benefit in a stdio-only server

**Desired state:** A production-grade Node.js/TypeScript MCP server that:
- Exposes `web_search` and `web_fetch` as MCP tools over stdio
- Uses raw REST API calls (no `ollama` npm package)
- Handles every failure mode explicitly with structured error responses
- Validates configuration at startup (fail fast on missing API key)
- Truncates oversized responses to protect LLM context windows
- Times out hung requests with `AbortController`
- Never leaks the API key in logs or error messages
- Validates Ollama response shapes at runtime to catch API changes early
- Validates input at the schema layer (URL format) before reaching the API
- Shuts down gracefully on SIGTERM/SIGINT

## Axioms & Constraints

1. **No `ollama` npm package** — raw `fetch()` to `https://ollama.com/api/web_search` and `/api/web_fetch`. Full control over error handling, timeout, and response processing with zero extra deps.

2. **stdio transport only** — stdout is reserved for JSON-RPC. All logging must use `console.error()`.

3. **Separate implementation from MCP registration** — following the Python pattern of `_web_search_impl` / `_web_fetch_impl`, the TS version must have standalone implementation functions called from `registerTool` handlers. Makes them independently testable and keeps concerns separated.

4. **Return raw JSON, not formatted text** — the Python version returns `model_dump()` (structured data). LLMs process structured JSON better than free-form text. The TS version must return `JSON.stringify()` of the Ollama API response.

5. **`max_results` defaults to 3** — matching the Python version's deliberate override of the API's default of 5. Keeps results concise for LLM context windows.

6. **Fail fast on missing API key** — validate `OLLAMA_API_KEY` at startup, before any tool is called. The Python version defers this to the SDK, which only errors at call time.

7. **Never leak `OLLAMA_API_KEY`** — error messages and logs must not contain the key value. Redact to `"***"` if referenced.

8. **Validate response shapes at runtime** — blind `as` casts are forbidden. Each `ollamaFetch` response must be validated against its expected shape before being returned. If Ollama changes their API, the error message must be "Unexpected response shape from Ollama API" — not a cryptic `undefined` access.

9. **Zod `z.object()` for schemas with `.default()`** — the building-mcp-nodejs SKILL mandates `z.object()` form when using `.default()`. The plain-object form does not produce correct JSON Schema for defaults.

## Domain Study Summary

### Source files read

| File                                                                | Purpose                       | Key findings                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-search-mcp.py`                                                   | Current Python implementation | No error handling, no timeouts, no logging; dual-path (FastMCP vs Server) is unnecessary complexity; `max_results` defaults to 3; returns `model_dump()`                                                                          |
| `.agents/skills/building-mcp-nodejs/SKILL.md`                         | MCP Node.js SDK patterns      | Use `McpServer` + `StdioServerTransport`; `registerTool(name, config, handler)` with 3 args; inputSchema uses Zod; handlers are async; `z.object()` required for `.default()`; annotations available; error handling with `isError: true` |
| `.agents/skills/building-mcp-nodejs/references/transport-setup.md`    | Transport configuration       | stdio: `StdioServerTransport`, never `console.log`, client sends SIGTERM→SIGKILL for shutdown                                                                                                                                     |
| `.agents/skills/building-mcp-nodejs/references/auth-and-lifecycle.md` | Auth & lifecycle              | Initialization handshake required; shutdown is transport-level (SIGTERM); capabilities declared at init                                                                                                                       |
| `.agents/skills/ollama-web-search/SKILL.md`                           | Ollama API reference          | `POST /api/web_search` returns `{results: [{title, url, content}]}`; `POST /api/web_fetch` returns `{title, content, links}`; auth via `Authorization: Bearer`; `max_results` max 10                                                      |
| `plan.md`                                                             | Existing plan draft           | Good foundation but contains Zod schema bug (plain-object form with `.default()`), no JSON parsing safety, no URL validation, no graceful shutdown, no response shape validation                                                |

### API response shapes (verified)

**`POST https://ollama.com/api/web_search`**
- Request: `{ "query": string, "max_results": integer }`
- Response: `{ "results": [{ "title": string, "url": string, "content": string }] }`
- Constraints: `max_results` default 5, max 10

**`POST https://ollama.com/api/web_fetch`**
- Request: `{ "url": string }`
- Response: `{ "title": string, "content": string, "links": string[] }`
- Risk: `content` field can be very large (full page text)

**Error responses**: Not documented by Ollama. Must handle:
- HTTP 401 (invalid/expired API key)
- HTTP 429 (rate limited)
- HTTP 5xx (server error)
- Non-JSON response body (even with 200 status)
- Network timeout / connection refused

### Dependency map

```
src/index.ts
  ├── @modelcontextprotocol/sdk/server/mcp.js   (McpServer)
  ├── @modelcontextprotocol/sdk/server/stdio.js  (StdioServerTransport)
  ├── zod                                         (input validation + response validation)
  └── node:process                                (SIGTERM/SIGINT handlers)
```

No cross-file dependencies within the project. Single entry point.

### Correct `registerTool` API (verified from SKILL.md)

```typescript
server.registerTool(
  "tool_name",
  {
    description: "...",
    inputSchema: z.object({ ... }),  // z.object() required for .default()
    annotations: { ... },             // optional
  },
  async (args) => {
    return { content: [{ type: "text", text: "..." }] };
  }
);
```

## Selected Lenses

| Lens            | Why selected                                      | Key concerns                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Risk / Failure**  | Every external API call can fail in multiple ways | What happens when Ollama is down, returns bad JSON, times out, or rate-limits? The Python version has zero error handling — this lens is the highest priority.                                                     |
| **Security**        | API key handling, input sanitization              | `OLLAMA_API_KEY` must never appear in logs/output. `web_fetch` accepts arbitrary URLs — Ollama validates server-side, but the MCP tool should validate URL format at the schema layer to fail fast on obvious garbage. |
| **Performance**     | Network I/O is the bottleneck                     | Native `fetch()` has no default timeout. A hung request blocks the Node event loop's I/O. Need `AbortController`. `web_fetch` can return megabytes — need truncation to protect LLM context windows.                     |
| **Maintainability** | Future-proofing against API changes               | If Ollama changes their response shape, blind `as` casts produce cryptic runtime errors. Runtime shape validation makes the failure mode explicit and debuggable.                                                    |

## Phase Breakdown

### Phase 1: Project Scaffolding

**Objective:** Create the project skeleton with all configuration files so that `npm run build` succeeds (even with a placeholder `index.ts`).

**Preconditions:** Node.js 18+ installed, working directory is `/mnt/work/ollama-web-search-mcp/`.

**Steps:**

1. Create `package.json`:
```json
{
  "name": "ollama-web-search-mcp",
  "version": "1.0.0",
  "description": "MCP server exposing Ollama web_search and web_fetch as tools",
  "type": "module",
  "main": "build/index.js",
  "bin": {
    "ollama-web-search-mcp": "build/index.js"
  },
  "scripts": {
    "build": "tsc && chmod 755 build/index.js",
    "dev": "node --import tsx src/index.ts",
    "start": "node build/index.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0",
    "tsx": "^4.0.0"
  }
}
```

2. Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

3. Create `.gitignore`:
```
node_modules/
build/
*.js.map
```

4. Create `src/` directory and a placeholder `src/index.ts`:
```typescript
#!/usr/bin/env node
console.error("placeholder");
```

5. Run `npm install` to resolve dependencies.

6. Run `npm run build` to verify the build pipeline works.

**Verification:**
- [ ] `npm run build` exits 0
- [ ] `build/index.js` exists and is executable
- [ ] `node build/index.js` prints "placeholder" to stderr

**Outputs:** `package.json`, `tsconfig.json`, `.gitignore`, `src/index.ts` (placeholder), `node_modules/`, `build/`

**⏸️ Checkpoint:** Verify `npm run build` succeeds before proceeding. If TypeScript or dependency resolution fails, fix here — later phases depend on a working build pipeline.

---

### Phase 2: Core Server & Implementation Functions

**Objective:** Implement the full MCP server with both tools, including all error handling, timeout, truncation, response shape validation, graceful shutdown, and API key validation.

**Preconditions:** Phase 1 complete — build pipeline works.

**Steps:**

1. 🔴 **CRITICAL**: Write `src/index.ts` with the following structure (each section detailed below):

   **a. Shebang + imports:**
   ```typescript
   #!/usr/bin/env node

   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
   import { z } from "zod";
   ```

   **b. Constants:**
   ```typescript
   const OLLAMA_API_BASE = "https://ollama.com/api";
   const REQUEST_TIMEOUT_MS = 30_000;
   const MAX_FETCH_CONTENT_LENGTH = 50_000;
   ```

   **Why these values:**
   - 30s timeout: Ollama's API typically responds in 1-5s. 30s is generous enough for slow connections but prevents infinite hangs. This is a structural fix for a failure mode the Python version doesn't handle at all.
   - 50k char truncation: At ~4 chars/token, 50k chars ≈ 12.5k tokens. Without truncation, a single `web_fetch` result could consume the entire LLM context window. The Python version has no truncation.

   **c. API key validation (fail fast):**
   ```typescript
   const apiKey = process.env.OLLAMA_API_KEY;
   if (!apiKey) {
     console.error("ERROR: OLLAMA_API_KEY environment variable is required");
     process.exit(1);
   }
   ```

   🔴 **CRITICAL**: This runs at module load time, before the MCP server starts. There is no path where a tool call is attempted without a key present.

   **d. Helper: `ollamaFetch` (shared HTTP call with timeout, auth, JSON safety, and error handling):**
   ```typescript
   async function ollamaFetch(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
     const controller = new AbortController();
     const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

     try {
       const response = await fetch(`${OLLAMA_API_BASE}${endpoint}`, {
         method: "POST",
         headers: {
           "Content-Type": "application/json",
           "Authorization": `Bearer ${apiKey}`,
         },
         body: JSON.stringify(body),
         signal: controller.signal,
       });

       if (!response.ok) {
         const text = await response.text().catch(() => "");
         if (response.status === 401) {
           throw new Error("Unauthorized: OLLAMA_API_KEY is invalid or expired");
         }
         if (response.status === 429) {
           throw new Error("Rate limited: too many requests to Ollama API");
         }
         throw new Error(
           `Ollama API error: HTTP ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`
         );
       }

       let data: unknown;
       try {
         data = await response.json();
       } catch {
         throw new Error(
           "Ollama API returned a non-JSON response. The API may be experiencing issues."
         );
       }
       return data;
     } catch (error) {
       if (error instanceof Error && error.name === "AbortError") {
         throw new Error(
           `Request to Ollama API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
         );
       }
       throw error;
     } finally {
       clearTimeout(timeout);
     }
   }
   ```

   🔴 **CRITICAL**: Every Ollama API call goes through `ollamaFetch`. This ensures:
   - Timeout is always applied (no path to bypass it)
   - Auth header is always included
   - HTTP errors are always caught and converted to structured errors
   - The API key is never included in error messages
   - Non-JSON 200 responses are caught explicitly (separate from the `!response.ok` path)

   **What changed from original plan.md:** Added `try/catch` around `response.json()` with a descriptive error. Without this, if Ollama returns a 200 with an HTML error page, `response.json()` throws `SyntaxError: Unexpected token <` — a confusing message that gives no hint about what happened.

   **e. Response shape validation helpers:**

   ```typescript
   const WebSearchResultSchema = z.object({
     title: z.string(),
     url: z.string(),
     content: z.string(),
   });

   const WebSearchResponseSchema = z.object({
     results: z.array(WebSearchResultSchema),
   });

   const WebFetchResponseSchema = z.object({
     title: z.string(),
     content: z.string(),
     links: z.array(z.string()),
   });
   ```

   🟡 **STRUCTURAL**: These schemas validate the shape of Ollama's response at runtime. If Ollama renames `content` to `body` or changes `results` to `items`, the Zod parse fails with a clear error listing the missing/extra fields — instead of a cryptic `Cannot read properties of undefined (reading 'content')` later. This is the maintainability lens in action: making API contract drift detectable at the point of ingestion.

   **Fragility:** If Ollama adds optional fields to their response, `z.object()` will pass them through by default (no `strict()` mode). Only missing required fields cause failure. This is the correct behavior — we validate what we depend on, not what we don't.

   **f. Implementation functions (separated from MCP registration, following Python pattern):**

   ```typescript
   type WebSearchResponse = z.infer<typeof WebSearchResponseSchema>;
   type WebFetchResponse = z.infer<typeof WebFetchResponseSchema>;

   async function webSearchImpl(
     query: string,
     maxResults: number = 3
   ): Promise<WebSearchResponse> {
     const raw = await ollamaFetch("/web_search", {
       query,
       max_results: maxResults,
     });
     const parsed = WebSearchResponseSchema.safeParse(raw);
     if (!parsed.success) {
       throw new Error(
         `Unexpected response shape from Ollama web_search API: ${parsed.error.message}`
       );
     }
     return parsed.data;
   }

   async function webFetchImpl(url: string): Promise<WebFetchResponse> {
     const raw = await ollamaFetch("/web_fetch", { url });
     const parsed = WebFetchResponseSchema.safeParse(raw);
     if (!parsed.success) {
       throw new Error(
         `Unexpected response shape from Ollama web_fetch API: ${parsed.error.message}`
       );
     }
     const data = parsed.data;
     if (data.content && data.content.length > MAX_FETCH_CONTENT_LENGTH) {
       data.content =
         data.content.slice(0, MAX_FETCH_CONTENT_LENGTH) +
         `\n\n[Content truncated at ${MAX_FETCH_CONTENT_LENGTH} characters. Original length: ${data.content.length} characters]`;
     }
     return data;
   }
   ```

   🟡 **STRUCTURAL**: Separating `webSearchImpl` / `webFetchImpl` from the MCP handlers mirrors the Python `_web_search_impl` / `_web_fetch_impl` pattern. Functions are independently callable (for testing or non-MCP use). Error handling in the MCP layer is consistent.

   🔴 **CRITICAL**: `webFetchImpl` truncates content. Without this, a single `web_fetch` call for a long Wikipedia page could return 500k+ characters, consuming the entire LLM context.

   🔴 **CRITICAL**: Both `*Impl` functions validate the response shape via `safeParse`. There is no path where unvalidated Ollama response data reaches the MCP client. If the shape is wrong, a descriptive error is thrown — and the MCP handler catches it and returns `isError: true`.

   **g. MCP tool registration:**

   ```typescript
   const server = new McpServer({
     name: "ollama-web-search",
     version: "1.0.0",
   });

   server.registerTool(
     "web_search",
     {
       description:
         "Search the web using Ollama's hosted search API. Returns a list of results with title, URL, and content snippet for each match.",
       inputSchema: z.object({
         query: z.string().describe("The search query string"),
         max_results: z
           .number()
           .min(1)
           .max(10)
           .default(3)
           .describe("Maximum number of results to return (default: 3, max: 10)"),
       }),
       annotations: {
         readOnlyHint: true,
       },
     },
     async ({ query, max_results }) => {
       try {
         const result = await webSearchImpl(query, max_results);
         return {
           content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
         };
       } catch (error) {
         return {
           content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
           isError: true,
         };
       }
     }
   );

   server.registerTool(
     "web_fetch",
     {
       description:
         "Fetch the content of a web page by URL using Ollama's hosted fetch API. Returns the page title, main content (truncated if very long), and links found on the page.",
       inputSchema: z.object({
         url: z
           .string()
           .url()
           .describe(
             "The absolute URL to fetch (e.g. https://example.com)"
           ),
       }),
       annotations: {
         readOnlyHint: true,
         openWorldHint: true,
       },
     },
     async ({ url }) => {
       try {
         const result = await webFetchImpl(url);
         return {
           content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
         };
       } catch (error) {
         return {
           content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
           isError: true,
         };
       }
     }
   );
   ```

   🟡 **STRUCTURAL**: `web_search` uses `z.object()` with `.default(3)` — not the plain-object form. The building-mcp-nodejs SKILL mandates `z.object()` when `.default()` is used. The original plan.md used the plain-object form, which does not produce correct JSON Schema for defaults.

   🟡 **STRUCTURAL**: `web_fetch` uses `z.string().url()` for URL validation — malformed URLs are rejected at the MCP schema layer before reaching the Ollama API. The original plan.md used `z.string()`, which would send garbage URLs to Ollama and rely on their validation.

   🟡 **STRUCTURAL**: Both tools have `readOnlyHint: true` — neither modifies any state. `web_fetch` additionally has `openWorldHint: true` because it accesses arbitrary URLs outside the server's control.

   🔴 **CRITICAL**: Both handlers wrap the impl call in try/catch and return `{ isError: true }` on failure. This is the MCP-compliant error pattern — the LLM receives the error as a tool result and can self-correct (retry, try different query/URL). Uncaught exceptions in MCP tool handlers cause undefined behavior. The Python version has no error handling at all.

   **h. Server startup + graceful shutdown:**

   ```typescript
   async function main() {
     const transport = new StdioServerTransport();
     await server.connect(transport);
     console.error("ollama-web-search MCP server running on stdio");

     const shutdown = () => {
       console.error("Shutting down...");
       process.exit(0);
     };

     process.on("SIGTERM", shutdown);
     process.on("SIGINT", shutdown);
   }

   main().catch((error) => {
     console.error("Fatal error starting MCP server:", error);
     process.exit(1);
   });
   ```

   🟡 **STRUCTURAL**: SIGTERM/SIGINT handlers ensure the process exits cleanly when the MCP client shuts down. The transport-setup reference doc specifies that clients close stdin then send SIGTERM — without a handler, in-flight JSON-RPC writes can be truncated, corrupting the protocol.

   🔴 **CRITICAL**: The top-level `main().catch()` handles unexpected startup errors (e.g., stdio transport failure). Without this, an unhandled promise rejection crashes the process with no message — the MCP client sees the server disappear silently.

2. Run `npm run build`.

3. Smoke test: `OLLAMA_API_KEY=test node build/index.js` — verify it starts (prints to stderr, does NOT crash despite placeholder key — key correctness is only verified at call time).

4. Kill the process (Ctrl+C).

**Verification:**
- [ ] `npm run build` exits 0 with no TypeScript errors
- [ ] `OLLAMA_API_KEY=test node build/index.js` prints "ollama-web-search MCP server running on stdio" to stderr
- [ ] Running without `OLLAMA_API_KEY` prints error and exits 1
- [ ] `console.log` does NOT appear anywhere in the source (only `console.error`)
- [ ] Both `z.object()` forms are used for `inputSchema` (not plain-object form)
- [ ] `.url()` validation is applied to the `url` parameter

**Outputs:** `src/index.ts` (full implementation), `build/index.js` (compiled)

**⏸️ Checkpoint:** The server starts and listens on stdio. The two tools are registered. Error handling and timeout are structural (no bypass path). Response shape validation is structural (no unvalidated data path). Graceful shutdown is wired. Before proceeding, mentally verify: "If Ollama API is down, does the server still respond to the MCP client?" Yes — `ollamaFetch` throws, the handler catches it, returns `isError: true`. The server stays alive.

---

### Phase 3: README & Client Configuration

**Objective:** Create documentation that lets users install, configure, and use the server with any MCP client.

**Preconditions:** Phase 2 complete — server builds and runs.

**Steps:**

1. Create `README.md` with these sections:

   **a. Title + one-liner:**
   > Ollama Web Search MCP Server — Expose Ollama's web search and web fetch APIs as MCP tools for AI assistants.

   **b. Prerequisites:**
   - Node.js 18 or later
   - An Ollama API key (get one at https://ollama.com/settings/keys)

   **c. Quick start:**
   ```bash
   git clone <repo> && cd ollama-web-search-mcp
   npm install
   npm run build
   OLLAMA_API_KEY=your_key node build/index.js
   ```

   **d. Client configuration (4 examples):**

   **Claude Desktop / Cline** (`claude_desktop_config.json`):
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

   **Claude Code** (CLI):
   ```bash
   claude mcp add ollama-web-search -e OLLAMA_API_KEY=your_key -- node /absolute/path/to/ollama-web-search-mcp/build/index.js
   ```

   **OpenAI Codex** (`~/.codex/config.toml`):
   ```toml
   [mcp_servers.ollama-web-search]
   command = "node"
   args = ["/absolute/path/to/ollama-web-search-mcp/build/index.js"]
   env = { OLLAMA_API_KEY = "your_api_key_here" }
   ```

   **Goose** (MCP server configuration UI):
   - Command: `node`
   - Args: `/absolute/path/to/ollama-web-search-mcp/build/index.js`
   - Environment: `OLLAMA_API_KEY=your_api_key_here`

   **e. Tools reference:**

| Tool       | Parameters                                                                  | Description                                                            |
| ---------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `web_search` | `query` (string, required), `max_results` (number, optional, default 3, max 10) | Search the web and return results with title, URL, and content snippet |
| `web_fetch`  | `url` (string, required, must be valid URL)                                   | Fetch a web page by URL and return its title, content, and links       |

   **f. Environment variables:**

| Variable       | Required | Description                            |
| -------------- | -------- | -------------------------------------- |
| `OLLAMA_API_KEY` | Yes      | Your Ollama API key for authentication |

   **g. Python version note:**
   > A Python implementation (`web-search-mcp.py`) is also included. Run it with `uv run web-search-mcp.py`.

2. 🟢 **COSMETIC**: Ensure consistent formatting — code blocks use correct language hints, paths use `/absolute/path/to/` placeholder.

**Verification:**
- [ ] README renders correctly in GitHub/VS Code markdown preview
- [ ] All client config examples use valid JSON/TOML
- [ ] Every config example includes the `OLLAMA_API_KEY` env var

**Outputs:** `README.md`

**⏸️ Checkpoint:** Read through the README as if you are a new user. Can you go from zero to a running server without asking any questions? If not, add the missing information now.

---

### Phase 4: Build Verification & Smoke Test

**Objective:** Confirm the entire project builds cleanly and the server responds to MCP protocol messages.

**Preconditions:** Phases 1-3 complete.

**Steps:**

1. Run `npm run build` — must exit 0 with no errors.

2. Verify no `console.log` in source:
   ```bash
   grep -n "console\.log" src/index.ts
   # Must return empty — only console.error is allowed
   ```

3. Test missing API key:
   ```bash
   node build/index.js
   # Must exit 1 with "OLLAMA_API_KEY environment variable is required" on stderr
   ```

4. Test with API key present (server should start and wait for stdin):
   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | OLLAMA_API_KEY=test node build/index.js 2>/dev/null
   # Must output JSON-RPC initialize response on stdout
   ```

5. Verify the `web_search` tool is listed:
   ```bash
   echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | OLLAMA_API_KEY=test node build/index.js 2>/dev/null
   # Must include web_search and web_fetch in the tools array
   ```

6. Verify `web_search` tool schema includes `max_results` with `default: 3`:
   ```bash
   # The tools/list response should show the inputSchema for web_search
   # with max_results having a default value of 3
   ```

7. Verify URL validation works on `web_fetch`:
   ```bash
   echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"web_fetch","arguments":{"url":"not-a-url"}}}' | OLLAMA_API_KEY=test node build/index.js 2>/dev/null
   # Must return an error (Zod validation failure for invalid URL)
   ```

**Verification:**
- [ ] `npm run build` succeeds
- [ ] No `console.log` in source
- [ ] Server exits 1 without API key
- [ ] Server responds to MCP `initialize` message
- [ ] Both tools appear in `tools/list` response
- [ ] `web_search` schema includes `max_results` default of 3
- [ ] `web_fetch` rejects malformed URLs at the schema layer

**Outputs:** Verified working build.

**⏸️ Checkpoint:** If any verification step fails, fix the issue before proceeding. A server that can't respond to basic MCP messages or validate inputs is not deployable.

---

## Risk Registry

| #   | Risk                                       | Likelihood | Impact                                | Mitigation                                                                                                                                                        |
| --- | ------------------------------------------ | ---------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Ollama API is down or unreachable          | Medium     | Tool calls fail                       | `ollamaFetch` catches network errors, returns `isError: true` so LLM can self-correct                                                                                 |
| 2   | `OLLAMA_API_KEY` is invalid                  | Medium     | 401 responses                         | `ollamaFetch` converts 401 to descriptive error (without leaking key), LLM can inform user                                                                          |
| 3   | Ollama rate limiting (429)                 | Low-Medium | Temporary block                       | `ollamaFetch` converts 429 to "Rate limited" message; LLM can back off                                                                                              |
| 4   | `web_fetch` returns huge content             | High       | LLM context overflow                  | `webFetchImpl` truncates at 50k chars with truncation notice                                                                                                        |
| 5   | Request hangs forever                      | Low        | MCP server unresponsive               | `AbortController` with 30s timeout in `ollamaFetch` — structurally impossible to hang                                                                                 |
| 6   | API key leaked in logs/errors              | Low        | Security exposure                     | Error messages use "invalid or expired" — never include key value. Phase 4 verifies no `console.log`                                                                |
| 7   | Non-JSON response from Ollama (200 status) | Low        | `response.json()` throws                | `ollamaFetch` wraps `response.json()` in try/catch with descriptive error                                                                                             |
| 8   | Ollama changes API response shape          | Low        | Runtime errors from `undefined` access  | `WebSearchResponseSchema.safeParse()` / `WebFetchResponseSchema.safeParse()` validate shape before returning — drift produces clear "Unexpected response shape" error |
| 9   | Malformed URL passed to `web_fetch`          | Medium     | Wasted API call to Ollama for garbage | `z.string().url()` rejects invalid URLs at the MCP schema layer — never reaches the API                                                                             |
| 10  | Process killed during in-flight request    | Low        | Truncated JSON-RPC on stdout          | SIGTERM/SIGINT handlers ensure clean exit                                                                                                                         |
| 11  | MCP SDK breaking API change                | Low        | Build fails                           | Pin SDK version with `^1.12.0` (semver compatible). The `registerTool` 3-arg API is stable in v1.x                                                                    |

## Checkpoint Gates

| Gate | Location      | Key question                                                                               |
| ---- | ------------- | ------------------------------------------------------------------------------------------ |
| 1    | After Phase 1 | Does `npm run build` succeed?                                                                |
| 2    | After Phase 2 | Does the server start, respond to MCP messages, and structurally handle all failure modes? |
| 3    | After Phase 3 | Can a new user go from zero to running server with only the README?                        |
| 4    | After Phase 4 | Do all smoke tests pass? Is the `z.object()` form used? Does URL validation work?            |

## Self-Check Verification

| #   | Check                                                                                                                         | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Depth Over Brevity**: Is every phase detailed enough for a worker to execute without asking clarifying questions?               | ✅     | Phase 2 specifies exact function signatures, Zod schemas, error messages, constant values, and code structure with inline code blocks. No ambiguity.                                                                                                                                                                                                                                                                                        |
| 2   | **Study Before Synthesis**: Did I read the actual source, or did I plan from description alone?                                   | ✅     | Read `web-search-mcp.py`, all 3 SKILL.md files, both reference docs, and existing `plan.md`. Corrected 6 gaps found in existing plan from source verification.                                                                                                                                                                                                                                                                                  |
| 3   | **Multi-Lens Analysis**: Did I apply ≥3 lenses? Are blind spots addressed?                                                        | ✅     | Risk/Failure, Security, Performance, Maintainability — four lenses applied. Risk registry has 11 items. Maintainability lens caught response shape validation gap. Security lens caught key-leak risk and URL validation gap. Performance lens caught timeout and truncation gaps.                                                                                                                                                          |
| 4   | **Domain Adaptation**: Is the plan structure adapted to this specific domain?                                                     | ✅     | MCP server domain: follows the SDK's tool registration pattern (`z.object()` for `.default()`), handles stdio constraints (`console.error` only, SIGTERM handlers), includes client config examples for 4 different MCP clients, adds MCP-specific annotations.                                                                                                                                                                                   |
| 5   | **Living Hypothesis**: Are checkpoint gates present?                                                                              | ✅     | 4 checkpoint gates, one per phase. Each asks "are we on track?" before proceeding.                                                                                                                                                                                                                                                                                                                                                          |
| 6   | **Phased & Atomic**: Can each phase stand alone? Is rollback possible per phase?                                                  | ✅     | Phase 1 (scaffolding) is independent. Phase 2 (implementation) builds on Phase 1. Phase 3 (docs) is independent of Phase 2. Phase 4 (verification) depends on 1-3. Each phase produces verifiable outputs.                                                                                                                                                                                                                                  |
| 7   | **Weighted Instructions**: Are critical vs. structural vs. cosmetic steps distinguished?                                          | ✅     | 7 🔴 CRITICAL markers (timeout, error handling, key validation, content truncation, key leak prevention, JSON parsing safety, response shape validation), 6 🟡 STRUCTURAL markers (separation of concerns, annotations, `z.object()` form, URL validation, `readOnlyHint`, top-level catch, graceful shutdown), 1 🟢 COSMETIC.                                                                                                                  |
| 8   | **Complex Topics Explained**: Are load-bearing code sections explained with the 5-point protocol?                                 | ✅     | `ollamaFetch` (what/why/how/fragility/coupling), `safeParse` validation (what/why/how/fragility/coupling), truncation logic, `z.object()` form requirement — all explained inline with reasoning.                                                                                                                                                                                                                                                 |
| 9   | **No Assumptions**: Did I verify every file path, function name, and dependency?                                                  | ✅     | Verified `@modelcontextprotocol/sdk` API via SKILL.md (found `z.object()` requirement), verified Ollama API response shapes via official docs, verified Zod `.default()` requires `z.object()`, verified `StdioServerTransport` import path, verified SIGTERM lifecycle from transport-setup reference.                                                                                                                                               |
| 10  | **Concrete Examples**: Did I use before/after examples where rules needed clarification?                                          | ✅     | Original plan.md Zod form vs corrected form, `z.string()` vs `z.string().url()`, blind `as` cast vs `safeParse()`.                                                                                                                                                                                                                                                                                                                                  |
| 11  | **Reasoned Conviction**: Does the plan *prove* compliance through structure, or merely *claim* it?                                    | ✅     | Error handling: "every Ollama API call goes through `ollamaFetch`" — no bypass path. Timeout: `AbortController` in `ollamaFetch` — no call can hang. API key: startup check — no tool call without key. Response shape: `safeParse` — no unvalidated data reaches client. URL validation: `z.string().url()` — no malformed URL reaches API. JSON safety: try/catch on `response.json()` — no unhandled parse error. Each claim has a structural proof. |
| 12  | **Deep Thinking**: Did I sit with the problem, exhaust the space, identify unknowns, simulate execution, stress-test assumptions? | ✅     | Identified 6 gaps in existing plan through source verification. Stress-tested: "what if Ollama returns non-JSON with 200? what if their shape changes? what if a malformed URL is sent? what if the process is killed mid-request?" — all answered with structural mitigations.                                                                                                                                                             |

---

**Key differences from the original `plan.md`:**

| Change                    | Original                                                               | Revised                                                             | Reason                                                         |
| ------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------- |
| Zod `inputSchema` form      | Plain-object `{ query: z.string(), max_results: z.number().default(3) }` | `z.object({ query: z.string(), max_results: z.number().default(3) })` | SKILL mandates `z.object()` for `.default()`                       |
| URL validation            | `z.string()`                                                             | `z.string().url()`                                                    | Fail fast on malformed URLs at schema layer                    |
| JSON parsing safety       | No try/catch on `response.json()`                                        | `try/catch` with descriptive error                                    | Non-JSON 200 responses produce clear errors                    |
| Response shape validation | `as WebSearchResponse` cast                                              | `safeParse()` with Zod schemas                                        | Detects API contract drift with clear errors                   |
| Graceful shutdown         | None                                                                   | SIGTERM/SIGINT handlers                                             | Clean exit per MCP lifecycle spec                              |
| Tool annotations          | Only `openWorldHint` on `web_fetch`                                        | `readOnlyHint: true` on both, `openWorldHint` on `web_fetch`              | Complete annotation per SKILL reference                        |
| Risk registry             | 8 items                                                                | 11 items                                                            | Added non-JSON 200, shape drift, malformed URL, killed process |

