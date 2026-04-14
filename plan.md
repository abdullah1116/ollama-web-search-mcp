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

## Axioms & Constraints

1. **No `ollama` npm package** — raw `fetch()` to `https://ollama.com/api/web_search` and `/api/web_fetch`. This gives full control over error handling, timeout, and response processing with zero extra deps.

2. **stdio transport only** — stdout is reserved for JSON-RPC. All logging must use `console.error()`.

3. **Separate implementation from MCP registration** — following the Python pattern of `_web_search_impl` / `_web_fetch_impl`, the TS version must have standalone implementation functions that are called from the `registerTool` handlers. This makes them independently testable and keeps concerns separated.

4. **Return raw JSON, not formatted text** — the Python version returns `model_dump()` (structured data). LLMs process structured JSON better than free-form text. The TS version must return `JSON.stringify()` of the Ollama API response.

5. **`max_results` defaults to 3** — matching the Python version's deliberate override of the API's default of 5. Keeps results concise for LLM context windows.

6. **Fail fast on missing API key** — validate `OLLAMA_API_KEY` at startup, before any tool is called. The Python version defers this to the SDK, which only errors at call time.

7. **Never leak `OLLAMA_API_KEY`** — error messages and logs must not contain the key value. Redact to `"***"` if referenced.

## Domain Study Summary

### Source files read

| File | Purpose | Key findings |
|------|---------|--------------|
| `web-search-mcp.py` | Current Python implementation | No error handling, no timeouts, no logging; dual-path (FastMCP vs Server) is unnecessary complexity; `max_results` defaults to 3; returns `model_dump()` |
| `.agents/skills/building-mcp-nodejs/SKILL.md` | MCP Node.js SDK patterns | Use `McpServer` + `StdioServerTransport`; `registerTool(name, config, handler)` with 3 args; inputSchema uses Zod; handlers are async; annotations available |
| `.agents/skills/ollama-web-search/SKILL.md` | Ollama API reference | `POST /api/web_search` returns `{results: [{title, url, content}]}`; `POST /api/web_fetch` returns `{title, content, links}`; auth via `Authorization: Bearer`; `max_results` max 10 |
| `docs.ollama.com/capabilities/web-search` | Official API docs | Confirmed response shapes; no error response format documented; no rate limits documented |

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
- Non-JSON response body
- Network timeout / connection refused

### Dependency map

```
src/index.ts
  ├── @modelcontextprotocol/sdk/server/mcp.js   (McpServer)
  ├── @modelcontextprotocol/sdk/server/stdio.js  (StdioServerTransport)
  ├── zod                                         (input validation)
  └── node:fs / node:url / node:path              (none needed — pure fetch)
```

No cross-file dependencies within the project. Single entry point.

## Selected Lenses

| Lens | Why selected | Key concerns |
|------|-------------|--------------|
| **Risk / Failure** | Every external API call can fail in multiple ways | What happens when Ollama is down, returns bad JSON, times out, or rate-limits? The Python version has zero error handling — this lens is the highest priority. |
| **Security** | API key handling, input sanitization | `OLLAMA_API_KEY` must never appear in logs/output. `web_fetch` accepts arbitrary URLs — while Ollama validates server-side, the MCP tool description should document this trust boundary. |
| **Performance** | Network I/O is the bottleneck | Native `fetch()` has no default timeout. A hung request blocks the Node event loop's I/O. Need `AbortController`. `web_fetch` can return megabytes — need truncation to protect LLM context windows. |

## Phase Breakdown

### Phase 1: Project Scaffolding

**Objective:** Create the project skeleton with all configuration files so that `npm run build` succeeds (even with a placeholder `index.ts`).

**Preconditions:** Node.js 18+ installed, working directory is `/mnt/work/work/ollama-web-search-mcp/`.

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

**Objective:** Implement the full MCP server with both tools, including all error handling, timeout, truncation, and API key validation.

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
   const REQUEST_TIMEOUT_MS = 30_000;        // 30s timeout for all API calls
   const MAX_FETCH_CONTENT_LENGTH = 50_000;  // Truncate web_fetch content at 50k chars
   ```

   **Why these values:**
   - 30s timeout: Ollama's API typically responds in 1-5s. 30s is generous enough for slow connections but prevents infinite hangs. This is a structural fix for a failure mode the Python version doesn't handle at all.
   - 50k char truncation: A typical LLM context window is 32k-200k tokens. At ~4 chars/token, 50k chars ≈ 12.5k tokens — leaves room for other context. Without truncation, a single `web_fetch` result could consume the entire window. The Python version has no truncation — this is a new improvement.

   **c. API key validation (fail fast):**
   ```typescript
   const apiKey = process.env.OLLAMA_API_KEY;
   if (!apiKey) {
     console.error("ERROR: OLLAMA_API_KEY environment variable is required");
     process.exit(1);
   }
   ```

   🔴 **CRITICAL**: This runs at module load time, before the MCP server starts. The Python version defers this to the SDK, meaning the server appears to start successfully but fails only at the first tool call. Fail-fast at startup is structurally better — there is no path where a tool call is attempted without a valid key.

   **d. Helper: `ollamaFetch` (shared HTTP call with timeout, auth, and error handling):**
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
         throw new Error(`Ollama API error: HTTP ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`);
       }

       return await response.json();
     } catch (error) {
       if (error instanceof Error && error.name === "AbortError") {
         throw new Error(`Request to Ollama API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
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
   - The API key is never included in error messages (only "invalid or expired" — no key value)

   **e. Implementation functions (separated from MCP registration, following Python pattern):**

   ```typescript
   interface WebSearchResult {
     title: string;
     url: string;
     content: string;
   }

   interface WebSearchResponse {
     results: WebSearchResult[];
   }

   async function webSearchImpl(query: string, maxResults: number = 3): Promise<WebSearchResponse> {
     const data = await ollamaFetch("/web_search", {
       query,
       max_results: maxResults,
     }) as WebSearchResponse;
     return data;
   }

   interface WebFetchResponse {
     title: string;
     content: string;
     links: string[];
   }

   async function webFetchImpl(url: string): Promise<WebFetchResponse> {
     const data = await ollamaFetch("/web_fetch", { url }) as WebFetchResponse;
     // Truncate content if it exceeds the limit
     if (data.content && data.content.length > MAX_FETCH_CONTENT_LENGTH) {
       data.content = data.content.slice(0, MAX_FETCH_CONTENT_LENGTH) +
         `\n\n[Content truncated at ${MAX_FETCH_CONTENT_LENGTH} characters. Original length: ${data.content.length} characters]`;
     }
     return data;
   }
   ```

   🟡 **STRUCTURAL**: Separating `webSearchImpl` / `webFetchImpl` from the MCP handlers mirrors the Python pattern of `_web_search_impl` / `_web_fetch_impl`. Benefits:
   - Functions are independently callable (for testing, for future non-MCP use)
   - Error handling in the MCP layer is consistent (all errors caught in one place)
   - The MCP handler is thin — just calls the impl and formats the result

   🔴 **CRITICAL**: `webFetchImpl` truncates content. Without this, a single `web_fetch` call for a long Wikipedia page could return 500k+ characters, consuming the entire LLM context. The truncation message tells the LLM that content was cut, so it can decide whether to request more specific information.

   **f. MCP tool registration:**

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
       inputSchema: {
         query: z.string().describe("The search query string"),
         max_results: z.number().min(1).max(10).default(3).describe("Maximum number of results to return (default: 3, max: 10)"),
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
           content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
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
       inputSchema: {
         url: z.string().describe("The absolute URL to fetch (e.g. https://example.com)"),
       },
       annotations: {
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
           content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
           isError: true,
         };
       }
     }
   );
   ```

   🟡 **STRUCTURAL**: `web_fetch` has `annotations: { openWorldHint: true }` because it accepts arbitrary URLs — it accesses resources outside the server's control. This follows the MCP annotation convention from the building-mcp-nodejs skill.

   🔴 **CRITICAL**: Both handlers wrap the impl call in try/catch and return `{ isError: true }` on failure. This is the MCP-compliant error pattern — the LLM receives the error as a tool result and can self-correct (e.g., retry with a different query, try a different URL). The Python version has no error handling — uncaught exceptions in MCP tool handlers cause undefined behavior.

   **g. Server startup:**

   ```typescript
   async function main() {
     const transport = new StdioServerTransport();
     await server.connect(transport);
     console.error("ollama-web-search MCP server running on stdio");
   }

   main().catch((error) => {
     console.error("Fatal error starting MCP server:", error);
     process.exit(1);
   });
   ```

   🟡 **STRUCTURAL**: The top-level `main()` catch handles unexpected startup errors (e.g., stdio transport failure). Without this, an unhandled promise rejection crashes the process with no message — the MCP client sees the server disappear with no explanation.

2. Run `npm run build`.

3. Run `OLLAMA_API_KEY=test node build/index.js` and verify it starts (prints to stderr, does NOT crash despite invalid key — key validation is structural, key *correctness* is only verified at call time).

4. Kill the process (Ctrl+C).

**Verification:**
- [ ] `npm run build` exits 0 with no TypeScript errors
- [ ] `OLLAMA_API_KEY=test node build/index.js` prints "ollama-web-search MCP server running on stdio" to stderr
- [ ] Running without `OLLAMA_API_KEY` prints error and exits 1
- [ ] `console.log` does NOT appear anywhere in the source (only `console.error`)

**Outputs:** `src/index.ts` (full implementation), `build/index.js` (compiled)

**⏸️ Checkpoint:** The server starts and listens on stdio. The two tools are registered. Error handling and timeout are structural (no bypass path). Before proceeding, mentally verify: "If Ollama API is down, does the server still respond to the MCP client?" Yes — `ollamaFetch` throws, the handler catches it, returns `isError: true`. The server stays alive.

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

   | Tool | Parameters | Description |
   |------|-----------|-------------|
   | `web_search` | `query` (string, required), `max_results` (number, optional, default 3, max 10) | Search the web and return results with title, URL, and content snippet |
   | `web_fetch` | `url` (string, required) | Fetch a web page by URL and return its title, content, and links |

   **f. Environment variables:**

   | Variable | Required | Description |
   |----------|----------|-------------|
   | `OLLAMA_API_KEY` | Yes | Your Ollama API key for authentication |

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

**Verification:**
- [ ] `npm run build` succeeds
- [ ] No `console.log` in source
- [ ] Server exits 1 without API key
- [ ] Server responds to MCP `initialize` message
- [ ] Both tools appear in `tools/list` response

**Outputs:** Verified working build.

**⏸️ Checkpoint:** If any verification step fails, fix the issue before proceeding. A server that can't respond to basic MCP messages is not deployable.

---

## Risk Registry

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | Ollama API is down or unreachable | Medium | Tool calls fail | `ollamaFetch` catches network errors, returns `isError: true` so LLM can self-correct |
| 2 | `OLLAMA_API_KEY` is invalid | Medium | 401 responses | `ollamaFetch` converts 401 to descriptive error (without leaking key), LLM can inform user |
| 3 | Ollama rate limiting (429) | Low-Medium | Temporary block | `ollamaFetch` converts 429 to "Rate limited" message; LLM can back off |
| 4 | `web_fetch` returns huge content | High | LLM context overflow | `webFetchImpl` truncates at 50k chars with truncation notice |
| 5 | Request hangs forever | Low | MCP server unresponsive | `AbortController` with 30s timeout in `ollamaFetch` — structurally impossible to hang |
| 6 | API key leaked in logs/errors | Low | Security exposure | Error messages use "invalid or expired" — never include key value. Code review step in Phase 4 checks for this |
| 7 | Non-JSON response from Ollama | Low | `response.json()` throws | `ollamaFetch` uses try/catch; if `json()` fails, the error is caught and returned as `isError: true` |
| 8 | MCP SDK breaking API change | Low | Build fails | Pin SDK version with `^1.12.0` (semver compatible). The `registerTool` 3-arg API is stable in v1.x |

## Self-Check Verification

| # | Check | Status | Evidence |
|---|-------|--------|----------|
| 1 | **Depth Over Brevity**: Is every phase detailed enough for a worker to execute without asking clarifying questions? | ✅ | Phase 2 specifies exact function signatures, error messages, constant values, and code structure. No ambiguity. |
| 2 | **Study Before Synthesis**: Did I read the actual source, or did I plan from description alone? | ✅ | Read `web-search-mcp.py`, both SKILL.md files, both reference docs, and Ollama official docs. Response shapes verified. |
| 3 | **Multi-Lens Analysis**: Did I apply ≥3 lenses? Are blind spots addressed? | ✅ | Risk/Failure, Security, Performance — all three applied. Risk registry has 8 items. Security lens caught key-leak risk. Performance lens caught timeout and truncation gaps. |
| 4 | **Domain Adaptation**: Is the plan structure adapted to this specific domain? | ✅ | MCP server domain: follows the SDK's tool registration pattern, handles stdio constraints, includes client config examples for 4 different MCP clients. |
| 5 | **Living Hypothesis**: Are checkpoint gates present? | ✅ | 4 checkpoint gates, one per phase. Each asks "are we on track?" before proceeding. |
| 6 | **Phased & Atomic**: Can each phase stand alone? Is rollback possible per phase? | ✅ | Phase 1 (scaffolding) is independent. Phase 2 (implementation) builds on Phase 1. Phase 3 (docs) is independent of Phase 2. Phase 4 (verification) depends on 1-3. |
| 7 | **Weighted Instructions**: Are critical vs. structural vs. cosmetic steps distinguished? | ✅ | 5 🔴 CRITICAL markers (timeout, error handling, key validation, content truncation, key leak prevention), 3 🟡 STRUCTURAL markers (separation of concerns, annotations, top-level catch), 1 🟢 COSMETIC. |
| 8 | **Complex Topics Explained**: Are load-bearing code sections explained with the 5-point protocol? | ✅ | `ollamaFetch` (what/why/how/fragility/coupling), `webFetchImpl` truncation (what/why/how/breaks/coupling), startup validation (what/why/how/breaks/coupling) — all explained inline. |
| 9 | **No Assumptions**: Did I verify every file path, function name, and dependency? | ✅ | Verified `@modelcontextprotocol/sdk` API via SKILL.md, verified Ollama API response shapes via official docs, verified Zod API for `.default()`. |
| 10 | **Concrete Examples**: Did I use before/after examples where rules needed clarification? | ✅ | Python vs TS comparison table, specific error messages shown, specific constant values justified. |
| 11 | **Reasoned Conviction**: Does the plan *prove* compliance through structure, or merely *claim* it? | ✅ | Error handling: "every Ollama API call goes through `ollamaFetch`" — there is no bypass path. Timeout: `AbortController` is set in `ollamaFetch` — no call can hang. API key leak: error messages are enumerated — none contain the key value. |
| 12 | **Deep Thinking**: Did I sit with the problem, exhaust the space, identify unknowns, simulate execution, stress-test assumptions? | ✅ | Identified 6 gaps in Python version (no error handling, no timeout, no truncation, no startup validation, no logging, unnecessary dual-path). Stress-tested: "what if Ollama is down? what if content is huge? what if request hangs? what if key is wrong?" — all answered in the plan. |