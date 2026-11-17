# AGENTS.md

## What this is

MCP stdio server exposing Ollama's `web_search` and `web_fetch` APIs as tools.

- `src/index.ts` → `build/index.js` — **canonical** TypeScript implementation (single file, single entrypoint).
- `web-search-mcp.py` — legacy Python version kept as reference only. It deliberately lacks error handling, timeouts, and truncation (see `plan.md`); do not treat its patterns as desired behavior.

## Commands

- `npm run build` — `tsc && chmod 755 build/index.js` (the chmod matters for `bin`; don't drop it)
- `npm run dev` — run TS directly via `tsx`
- `npm start` — run `build/index.js`

No test suite, linter, typecheck script, or CI exists. `npm run build` is the only compile gate.

## Verification = JSON-RPC smoke tests (verified working)

```bash
# initialize handshake
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | OLLAMA_API_KEY=test node build/index.js

# tools/list must show web_search + web_fetch, max_results with default:3
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | OLLAMA_API_KEY=test node build/index.js

# malformed URL must be rejected at the schema layer (isError:true, "Invalid url")
echo '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"web_fetch","arguments":{"url":"not-a-url"}}}' | OLLAMA_API_KEY=test node build/index.js

# without key: must print to stderr and exit 1
node build/index.js
```

A dummy key is fine for smoke tests — key validity is only checked at API call time.

## Hard invariants (breaking these fails silently)

- **stdout is JSON-RPC only.** Never `console.log`; all logging via `console.error`. One stray `console.log` corrupts the protocol stream.
- Every Ollama API call goes through `ollamaFetch` — timeout (30s `AbortController`), auth header, structured errors. No direct `fetch()` calls.
- Validate Ollama response shapes with Zod `safeParse`; blind `as` casts are forbidden. Shape drift must fail with "Unexpected response shape from Ollama API", not a cryptic `undefined` access.
- Never put `OLLAMA_API_KEY` value in logs or error messages.
- `web_fetch` content is truncated at 50k chars (`MAX_FETCH_CONTENT_LENGTH`) to protect LLM context — keep truncation and its notice.
- MCP tool handlers catch errors and return `{ isError: true }`; never let an exception escape a handler.
- `inputSchema` must use the `z.object({...})` form when using `.default()` — the plain-object form emits wrong JSON Schema (verified: `default:3` shows up correctly in `tools/list`).

## Gotchas

- `OLLAMA_API_KEY` is validated at **module load** — the process exits 1 before the server starts if missing. Set any dummy value to run or smoke-test.
- ESM + `module: Node16`: relative imports need `.js` extensions. Node 18+ required (native `fetch`).
- `max_results` defaults to 3 on purpose (API default is 5) — deliberate, don't "fix" it.
- Tool results are raw `JSON.stringify` of the API response — structured JSON, not formatted prose. Keep it that way.

## References

- `plan.md` — design doc: rationale for every invariant above, risk registry, API response shapes.
- `.agents/skills/building-mcp-nodejs/` — MCP SDK patterns this code follows (`registerTool` 3-arg API, stdio lifecycle).
- `.agents/skills/ollama-web-search/` — Ollama API reference (endpoints, request/response shapes, limits).
