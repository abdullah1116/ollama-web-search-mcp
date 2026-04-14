#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OLLAMA_API_BASE = "https://ollama.com/api";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_FETCH_CONTENT_LENGTH = 50_000;

// ---------------------------------------------------------------------------
// API key validation (fail fast)
// ---------------------------------------------------------------------------

const apiKey = process.env.OLLAMA_API_KEY;
if (!apiKey) {
  console.error("ERROR: OLLAMA_API_KEY environment variable is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared HTTP helper
// ---------------------------------------------------------------------------

async function ollamaFetch(
  endpoint: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${OLLAMA_API_BASE}${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
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

// ---------------------------------------------------------------------------
// Response shape validation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Implementation functions (separated from MCP registration)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// MCP server & tool registration
// ---------------------------------------------------------------------------

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
        .describe(
          "Maximum number of results to return (default: 3, max: 10)"
        ),
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
        .describe("The absolute URL to fetch (e.g. https://example.com)"),
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

// ---------------------------------------------------------------------------
// Server startup & graceful shutdown
// ---------------------------------------------------------------------------

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