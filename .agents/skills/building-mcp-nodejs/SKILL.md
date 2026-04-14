---
name: building-mcp-nodejs
description: >
  Create MCP (Model Context Protocol) servers in Node.js/TypeScript using the official
  @modelcontextprotocol/sdk. Use this skill whenever the user wants to build an MCP server,
  create an MCP tool/resource/prompt, set up MCP transports (stdio or Streamable HTTP),
  configure MCP authentication, or asks about MCP server development in Node.js — even if
  they don't explicitly say "MCP" (e.g., "how do I expose an API for Claude to call",
  "connect my app to an AI assistant", "make a tool server forCursor/Claude Code").
---

# Building MCP Servers in Node.js

This skill guides you through creating production MCP (Model Context Protocol) servers using the official TypeScript SDK (`@modelcontextprotocol/sdk`, v1.x). MCP lets AI applications like Claude Code, Cursor, and VS Code discover and invoke your server's tools, resources, and prompts.

## Quick Start

A minimal stdio-based MCP server with one tool:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "my-server", version: "1.0.0" });

server.registerTool(
  "get_time",
  {
    description: "Get the current time in a timezone",
    inputSchema: {
      timezone: z.string().describe("IANA timezone, e.g. America/New_York"),
    },
  },
  async ({ timezone }) => {
    const time = new Date().toLocaleString("en-US", { timeZone: timezone });
    return { content: [{ type: "text", text: `Current time in ${timezone}: ${time}` }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
```

## Project Setup

### 1. Initialize

```bash
mkdir my-mcp-server && cd my-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk zod@3
npm install -D @types/node typescript
```

### 2. package.json

Add `"type": "module"` and a build script:

```json
{
  "type": "module",
  "scripts": {
    "build": "tsc && chmod 755 build/index.js"
  }
}
```

### 3. tsconfig.json

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

### 4. Directory structure

```
my-mcp-server/
├── src/
│   └── index.ts
├── build/
├── package.json
└── tsconfig.json
```

### 5. Client configuration

For Claude Desktop, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/absolute/path/to/build/index.js"]
    }
  }
}
```

For other clients (Cursor, VS Code Copilot, etc.), consult their MCP integration docs.

## The McpServer Class

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer(
  { name: "my-server", version: "1.0.0" },
  {
    instructions: "Always call list_tables before running queries.",
    capabilities: { logging: {} }
  }
);
```

- **`name`** / **`version`**: Identify your server in client UIs.
- **`instructions`**: Optional text the client adds to its system prompt when using your server.
- **`capabilities`**: Declare optional features. Only needed for `logging` and `tasks` — tools, resources, and prompts are auto-registered.

## Defining Tools

Tools are functions the LLM can call. Use `server.registerTool()`:

```typescript
server.registerTool(
  "calculate_bmi",
  {
    title: "BMI Calculator",
    description: "Calculate Body Mass Index from weight and height",
    inputSchema: z.object({
      weightKg: z.number().describe("Weight in kilograms"),
      heightM: z.number().describe("Height in meters"),
    }),
    outputSchema: z.object({ bmi: z.number() }),
  },
  async ({ weightKg, heightM }) => {
    const bmi = weightKg / (heightM * heightM);
    return {
      content: [{ type: "text", text: JSON.stringify({ bmi }) }],
      structuredContent: { bmi },
    };
  }
);
```

### inputSchema forms

Two forms are supported:

1. **Zod object** — `z.object({ name: z.string(), age: z.number() })`. Use for tools with multiple fields.
2. **Plain object with Zod fields** — `{ name: z.string(), age: z.number() }`. Use for flat parameter lists. This is the form shown in the Quick Start example.

Both produce valid JSON Schema at runtime. The Zod object form is required when you need nesting, optional fields, or `.default()`.

### Annotations

Annotations tell clients about a tool's behavior so they can show appropriate UI:

```typescript
server.registerTool(
  "delete_file",
  {
    description: "Delete a file",
    inputSchema: z.object({ path: z.string() }),
    annotations: {
      title: "Delete File",
      destructiveHint: true,
      idempotentHint: true,
    },
  },
  async ({ path }) => { /* ... */ }
);
```

Available annotations: `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.

### Error handling

Return `isError: true` to signal failures to the LLM so it can self-correct. Uncaught exceptions in tool handlers are automatically converted to error results.

```typescript
async ({ url }) => {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return { content: [{ type: "text", text: `HTTP ${res.status}` }], isError: true };
    }
    return { content: [{ type: "text", text: await res.text() }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Failed: ${error.message}` }], isError: true };
  }
}
```

### Returning resource links

Tools can return links to resources instead of inline content:

```typescript
server.registerTool(
  "list_files",
  { title: "List Files", description: "Returns files as resource links" },
  async () => ({
    content: [
      { type: "resource_link", uri: "file:///projects/readme.md", name: "README", mimeType: "text/markdown" },
    ],
  })
);
```

## Defining Resources

Resources are read-only data sources the application can fetch. Use `server.registerResource()`:

### Static resource

```typescript
server.registerResource(
  "config",
  "config://app",
  { title: "Application Config", description: "Current app configuration", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: "key=value\nport=3000" }],
  })
);
```

### Dynamic resource with URI template

```typescript
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

server.registerResource(
  "user-profile",
  new ResourceTemplate("user://{userId}/profile", {
    list: async () => ({
      resources: [
        { uri: "user://123/profile", name: "Alice" },
        { uri: "user://456/profile", name: "Bob" },
      ],
    }),
  }),
  { title: "User Profile", description: "User profile data", mimeType: "application/json" },
  async (uri, { userId }) => ({
    contents: [{ uri: uri.href, text: JSON.stringify({ id: userId, name: "Example User" }) }],
  })
);
```

- The `list` callback lets clients discover available resource instances.
- Template variables (e.g., `{userId}`) are extracted and passed to the read handler.

## Defining Prompts

Prompts are reusable templates users explicitly invoke. Use `server.registerPrompt()`:

```typescript
server.registerPrompt(
  "review-code",
  {
    title: "Code Review",
    description: "Review code for best practices",
    argsSchema: z.object({ code: z.string() }),
  },
  ({ code }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Review this code:\n\n${code}` } }],
  })
);
```

### Prompt with argument completion

```typescript
import { completable } from "@modelcontextprotocol/sdk/server/mcp.js";

server.registerPrompt(
  "review-code",
  {
    title: "Code Review",
    description: "Review code in a specific language",
    argsSchema: z.object({
      language: completable(z.string().describe("Programming language"), (value) =>
        ["typescript", "javascript", "python", "rust", "go"].filter((l) => l.startsWith(value))
      ),
    }),
  },
  ({ language }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Review this ${language} code.` } }],
  })
);
```

## Logging

Enable logging by adding `capabilities: { logging: {} }` to the server constructor, then use `ctx.mcpReq.log()` inside handlers:

```typescript
const server = new McpServer(
  { name: "my-server", version: "1.0.0" },
  { capabilities: { logging: {} } }
);

server.registerTool("fetch-data", { /* ... */ inputSchema: z.object({ url: z.string() }) },
  async ({ url }, ctx) => {
    await ctx.mcpReq.log("info", `Fetching ${url}`);
    const res = await fetch(url);
    return { content: [{ type: "text", text: await res.text() }] };
  }
);
```

Log levels: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`.

## Progress Notifications

For long-running operations, report progress using the `progressToken` from the request metadata:

```typescript
server.registerTool(
  "process-files",
  { description: "Process multiple files", inputSchema: z.object({ files: z.array(z.string()) }) },
  async ({ files }, ctx) => {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    for (let i = 0; i < files.length; i++) {
      if (progressToken !== undefined) {
        await ctx.mcpReq.notify({
          method: "notifications/progress",
          params: { progressToken, progress: i + 1, total: files.length },
        });
      }
    }
    return { content: [{ type: "text", text: `Processed ${files.length} files` }] };
  }
);
```

## Sampling (Server asks Client to run LLM)

Servers can request LLM completions through the client, enabling agentic behavior while staying model-independent:

```typescript
server.registerTool(
  "summarize",
  { description: "Summarize text using the client LLM", inputSchema: z.object({ text: z.string() }) },
  async ({ text }, ctx) => {
    const response = await ctx.mcpReq.requestSampling({
      messages: [{ role: "user", content: { type: "text", text: `Summarize: ${text}` } }],
      maxTokens: 500,
    });
    return { content: [{ type: "text", text: response.content[0].text }] };
  }
);
```

The client controls permissions — users review and approve both the request and response.

## Elicitation (Server asks User for Input)

Servers can request structured input from the user through the client:

```typescript
server.registerTool(
  "collect-feedback",
  { description: "Collect user feedback", inputSchema: z.object({}) },
  async (_args, ctx) => {
    const result = await ctx.mcpReq.elicitInput({
      mode: "form",
      message: "Please share your feedback:",
      requestedSchema: {
        type: "object",
        properties: { rating: { type: "number", minimum: 1, maximum: 5 } },
        required: ["rating"],
      },
    });
    if (result.action === "accept") {
      return { content: [{ type: "text", text: JSON.stringify(result.content) }] };
    }
    return { content: [{ type: "text", text: "User declined" }] };
  }
);
```

Never use elicitation for passwords, API keys, or other secrets.

## Common Pitfalls

1. **Never `console.log()` in stdio servers** — stdout is reserved for JSON-RPC messages. Use `console.error()` for all logging.
2. **Zod version** — Use `zod@3`. The SDK has a required peer dependency on Zod v3 (or v4 compatible). Don't use `zod@4` directly unless compatible.
3. **SDK version** — Use `@modelcontextprotocol/sdk` v1.x (current stable, ~v1.29.0). The v2 SDK (`@modelcontextprotocol/server` + `@modelcontextprotocol/client`) is pre-alpha and not production-ready.
4. **ESM required** — Your package.json must include `"type": "module"`. Import paths use `.js` extensions (e.g., `@modelcontextprotocol/sdk/server/mcp.js`) even in TypeScript source.
5. **async tool handlers** — All `registerTool` handlers must be `async` functions.
6. **Resource URI format** — Always use valid URI schemes. Custom schemes like `config://` or `user://` are fine; don't use bare strings.

## Transport Setup

For detailed transport configuration (stdio, Streamable HTTP, Express/Hono integration, DNS rebinding protection), see [references/transport-setup.md](references/transport-setup.md).

## Authentication & Lifecycle

For OAuth 2.1 authentication, session management, capability negotiation, and shutdown handling, see [references/auth-and-lifecycle.md](references/auth-and-lifecycle.md).

## MCP Primitives Summary

| Primitive | Who Controls | Method | Purpose |
|-----------|-------------|--------|---------|
| **Tools** | Model (LLM) | `tools/list`, `tools/call` | Execute actions |
| **Resources** | Application | `resources/list`, `resources/read` | Provide context data |
| **Prompts** | User | `prompts/list`, `prompts/get` | Template interactions |
| **Sampling** | Server → Client | `sampling/createMessage` | Request LLM completions |
| **Elicitation** | Server → Client | `elicitation/requestInput` | Request user input |

## Context Object (`ctx`)

Every handler receives a `ctx` argument with `mcpReq`, which provides:

- `ctx.mcpReq.log(level, message)` — Send log messages to the client
- `ctx.mcpReq.notify(notification)` — Send arbitrary notifications
- `ctx.mcpReq.request sampling(params)` — Request LLM completions from the client
- `ctx.mcpReq.elicitInput(params)` — Request structured user input
- `ctx.mcpReq._meta` — Access request metadata (e.g., `progressToken`)