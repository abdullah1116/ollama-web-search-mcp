#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HTTP_PORT = 33011;
const DEFAULT_IDLE_MS = 60_000;
const WORKER_REQUEST_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MCP_PATH = "/mcp";
const HTTP_BIND_HOST = "127.0.0.1";
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

const HTTP_PORT = Number(process.env.MCP_PORT) || DEFAULT_HTTP_PORT;
const IDLE_MS = Number(process.env.MCP_IDLE_MS) || DEFAULT_IDLE_MS;

// Derived at runtime on purpose: a literal specifier here would let esbuild
// inline the whole MCP stack into this cold-wrapper bundle.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_MODULE_PATH = path.join(MODULE_DIR, "server.js");

// Bridge shapes mirror the real module. Duplicated on purpose: a type import
// would make the wrapper's module graph reach the real code.
type BridgeRequest = {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  bodyText: string;
};

type BridgeResponse = {
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
};

// ---------------------------------------------------------------------------
// API key validation (fail fast, both modes)
// ---------------------------------------------------------------------------

const apiKey = process.env.OLLAMA_API_KEY;
if (!apiKey) {
  console.error("ERROR: OLLAMA_API_KEY environment variable is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP response helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

// ---------------------------------------------------------------------------
// Request guards
// ---------------------------------------------------------------------------

function isAllowedHost(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) {
    return false;
  }
  const [hostname, rawPort] = hostHeader.trim().toLowerCase().split(":");
  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    return false;
  }
  return rawPort === undefined || rawPort === "" || rawPort === String(port);
}

function isAllowedOrigin(origin: string): boolean {
  try {
    return ALLOWED_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Worker pool (exactly zero or one worker)
// ---------------------------------------------------------------------------

type Pending = {
  resolve: (response: BridgeResponse) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let terminating: Promise<void> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const pending = new Map<string, Pending>();

function rssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function failPending(error: Error): void {
  const entries = Array.from(pending.values());
  pending.clear();
  for (const entry of entries) {
    entry.reject(error);
  }
}

function terminateWorker(target: Worker): Promise<void> {
  const done = target.terminate().then(
    () => undefined,
    () => undefined
  );
  terminating = done;
  void done.then(() => {
    if (terminating === done) {
      terminating = null;
    }
  });
  return done;
}

async function getWorker(): Promise<Worker> {
  if (terminating) {
    await terminating;
  }
  if (worker) {
    return worker;
  }

  const spawned = new Worker(SERVER_MODULE_PATH);

  spawned.on("message", (message: BridgeResponse) => {
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    entry.resolve(message);
  });

  spawned.on("error", (error: Error) => {
    if (worker !== spawned) {
      return;
    }
    worker = null;
    console.error("worker error:", error.message);
    failPending(new Error("worker error"));
  });

  spawned.on("exit", (code: number) => {
    if (worker !== spawned) {
      return;
    }
    worker = null;
    console.error(`worker exited unexpectedly (code ${code})`);
    failPending(new Error("worker exited"));
  });

  worker = spawned;
  console.error(`real code warm (rss=${rssMb()}MB)`);
  return spawned;
}

function scheduleIdleEviction(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void evictIdleWorker();
  }, IDLE_MS);
  idleTimer.unref();
}

async function evictIdleWorker(): Promise<void> {
  const current = worker;
  if (!current) {
    return;
  }
  if (pending.size > 0) {
    scheduleIdleEviction();
    return;
  }

  worker = null;
  const before = rssMb();
  await terminateWorker(current);

  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") {
    gc();
  }
  const after = rssMb();
  console.error(
    `evicted after idle (rss ${before}→${after} MB, gc: ${typeof gc === "function" ? "invoked" : "unavailable"})`
  );
}

async function dropWorker(): Promise<void> {
  const current = worker;
  if (!current) {
    return;
  }
  worker = null;
  await terminateWorker(current);
}

async function forwardToWorker(
  request: BridgeRequest
): Promise<BridgeResponse> {
  const target = await getWorker();
  return new Promise<BridgeResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      reject(new Error("timeout"));
    }, WORKER_REQUEST_TIMEOUT_MS);

    pending.set(request.id, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });

    target.postMessage(request);
  });
}

// ---------------------------------------------------------------------------
// HTTP handling (cold wrapper)
// ---------------------------------------------------------------------------

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!isAllowedHost(req.headers.host, HTTP_PORT)) {
    sendJson(res, 403, { error: "forbidden host" });
    return;
  }

  const origin = req.headers.origin;
  if (origin !== undefined && !isAllowedOrigin(origin)) {
    sendJson(res, 403, { error: "forbidden origin" });
    return;
  }

  const pathname = new URL(
    req.url ?? "/",
    `http://${HTTP_BIND_HOST}:${HTTP_PORT}`
  ).pathname;

  if (pathname !== MCP_PATH) {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  const method = req.method ?? "GET";
  if (method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const bodyText = await readBody(req);
  if (bodyText === null) {
    sendJson(res, 413, { error: "payload too large" });
    return;
  }

  const request: BridgeRequest = {
    id: randomUUID(),
    method,
    url: `http://${HTTP_BIND_HOST}:${HTTP_PORT}${req.url ?? MCP_PATH}`,
    headers: req.headers,
    bodyText,
  };

  scheduleIdleEviction();

  try {
    const response = await forwardToWorker(request);
    res.writeHead(response.status, response.headers);
    res.end(response.bodyText);
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") {
      await dropWorker();
      sendJson(res, 500, { error: "timeout" });
      return;
    }
    sendJson(res, 500, { error: "internal" });
  } finally {
    scheduleIdleEviction();
  }
}

async function startHttpWrapper(): Promise<void> {
  const httpServer = createNodeServer((req, res) => {
    handleHttpRequest(req, res).catch((error) => {
      console.error("HTTP request error:", error);
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, 500, { error: "internal" });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(HTTP_PORT, HTTP_BIND_HOST, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  console.error(
    `wrapper up on http://${HTTP_BIND_HOST}:${HTTP_PORT}${MCP_PATH} (cold, idle-evict ${IDLE_MS}ms)`
  );

  const shutdown = () => {
    console.error("Shutting down...");
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    const current = worker;
    worker = null;
    httpServer.close();
    const finish = () => process.exit(0);
    if (current) {
      void terminateWorker(current).then(finish, finish);
    } else {
      finish();
    }
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ---------------------------------------------------------------------------
// stdio mode (real code loaded on demand)
// ---------------------------------------------------------------------------

async function startStdio(): Promise<void> {
  const { createServer } = await import(
    pathToFileURL(SERVER_MODULE_PATH).href
  );
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );

  const server = createServer();
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

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const start = process.argv[2] === "--http" ? startHttpWrapper : startStdio;

start().catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
