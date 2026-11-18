# AGENTS.md

## What this is

MCP server exposing Ollama's `web_search` and `web_fetch` APIs as tools. Two modes, one entrypoint:

- `node build/index.js` — **stdio** (default; per-client process)
- `node --expose-gc build/index.js --http` — **HTTP cold wrapper** on `http://127.0.0.1:33011/mcp` (`MCP_PORT`; `MCP_IDLE_MS` default 60000)

Build outputs: `build/index.js` = cold wrapper + stdio launcher (contains no MCP tool code); `build/server.js` = the real code (tree-shaken MCP stack, lazy-loaded per request into a worker isolate, dropped after idle via `worker.terminate()` + `global.gc()`).

- `src/index.ts` → wrapper/launcher · `src/server.ts` = real code AND worker entry (`!isMainThread`)

## Commands

- `npm run build` — `tsc --noEmit` (the only compile/type gate; no tests, linter, or CI exist) + esbuild bundle (`--tree-shaking=true`) + `chmod 755 build/index.js` (the chmod matters for `bin`; don't drop it)
- `npm run dev` — run TS directly via `tsx` (stdio mode)
- `./scripts/install-service.sh` / `--uninstall` — systemd **user** service; unit template in `systemd/`; key lives in `~/.config/ollama-web-search-mcp/env`
- `journalctl --user -u ollama-web-search-mcp -f` — service logs

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

HTTP mode (start with `node --expose-gc build/index.js --http &`):

```bash
curl -s -X POST http://127.0.0.1:33011/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```

- The `Accept` header is **mandatory** (spec) — without `text/event-stream` the transport answers 406; don't debug that as a server bug.
- `-H 'Host: evil.example'` must return 403 (DNS-rebinding guard).
- Boot stderr says `wrapper up … (cold)` with NO `real code loaded`; first request adds `real code loaded (rss=…)`; `MCP_IDLE_MS` idle later adds `evicted after idle (rss XX→YY MB, gc: …)`; the next request cold-loads again. Those three lines are the memory-lifecycle contract — keep them.

## Hard invariants (breaking these fails silently)

- **Import fence**: `src/index.ts` must never import `./server.js` statically or via a literal `import("./server.js")` — only the derived-specifier `await import(...)` / `new Worker(path)` form. Mechanism: a literal specifier lets esbuild inline the MCP stack into the wrapper bundle, which kills lazy-load. Gate: `grep -c registerTool build/index.js` must be 0.
- **stdout is JSON-RPC only** (stdio mode). Never `console.log`; all logging via `console.error`. One stray `console.log` corrupts the protocol stream.
- Every Ollama API call goes through `ollamaFetch` — a retry loop over `classify()` in `src/recovery.ts`: 55s total deadline, per-attempt timeouts 15s/30s, `Retry-After` honored (delay-seconds or HTTP-date), full-jitter backoff. No direct `fetch()` calls. **A 200 with an empty body is quota exhaustion, not success** — that check must stay before any JSON parse (upstream ships it this way: ollama/ollama#16045).
- Validate Ollama response shapes with Zod `safeParse`; blind `as` casts are forbidden. Shape drift must fail with "Unexpected response shape from Ollama API", not a cryptic `undefined` access.
- Never put `OLLAMA_API_KEY` value in logs or error messages.
- `web_fetch` content is truncated at 50k chars (`MAX_FETCH_CONTENT_LENGTH`) to protect LLM context — keep truncation and its notice.
- MCP tool handlers catch errors and return `{ isError: true }`; never let an exception escape a handler (or cross the worker bridge).
- `inputSchema` must use the `z.object({...})` form when using `.default()` — the plain-object form emits wrong JSON Schema (verified: `default:3` shows up correctly in `tools/list`).

## Gotchas

- `OLLAMA_API_KEY` is validated at **module load** — the process exits 1 before serving if missing/empty. The systemd service with an empty key crash-loops (Restart=on-failure); set the key in `~/.config/ollama-web-search-mcp/env` before starting.
- The worker bridge uses the SDK **web-standard** `handleRequest(Request) → Response` in `server.ts` — the v1 node `handleRequest` requires real `IncomingMessage`/`ServerResponse` streams and cannot cross a worker boundary. Don't "simplify" it to the node variant.
- `@modelcontextprotocol/sdk` and `zod` are **devDependencies on purpose** — esbuild bundles them (tree-shaken) into `build/server.js`; moving them to `dependencies` makes npm users download them unused.
- `files: ["build","scripts","systemd"]` — `scripts/install-service.sh` renders the `systemd/` unit template; dropping `systemd/` breaks the installer for npm consumers.
- ESM + `module: Node16`: relative imports need `.js` extensions (tsx maps `.js` → `.ts` in dev). Node 18+ required (native `fetch`).
- `max_results` defaults to 3 on purpose (API default is 5) — deliberate, don't "fix" it.
- Tool results are raw `JSON.stringify` of the API response — structured JSON, not formatted prose. Keep it that way.
- `OLLAMA_API_BASE` overrides the API root (default `https://ollama.com/api`) — the error-mock test suite depends on it. `web_fetch` `{"error":"not found"}` means the target was blocked upstream, NOT that the URL is invalid (ollama#18143).
- HTTP mode binds `127.0.0.1` only and is stateless (one transport per request) — no session ids, no GET SSE stream (405). That is deliberate: restart-safe with zero server-side state.

