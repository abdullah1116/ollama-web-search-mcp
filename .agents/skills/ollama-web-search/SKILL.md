---
name: ollama-web-search
description: >
  Use Ollama's web search and web fetch APIs to augment models with real-time
  information from the internet. Use this skill whenever you need to search the
  web, fetch web pages, set up an MCP server for Ollama search, integrate Ollama
  web search into a project, or build a search agent — even if you don't
  explicitly say "Ollama" (e.g., "add web search to my app", "search the
  internet for...", "fetch this URL's content", "set up a search MCP server",
  "reduce hallucinations with real-time data").
---

# Ollama Web Search & Fetch

Ollama provides hosted APIs for web search and web page fetching that can augment models with up-to-date information, reduce hallucinations, and improve accuracy. This skill covers the REST API, Python/JS SDKs, and MCP server integration.

## Authentication

All requests require an Ollama API key. Create one at [ollama.com/settings/keys](https://ollama.com/settings/keys) (free account required).

Set the `OLLAMA_API_KEY` environment variable or pass it in the `Authorization: Bearer` header.

## Web Search API

Search the web and return relevant results.

**`POST https://ollama.com/api/web_search`**

| Parameter     | Type    | Required | Description                          |
|---------------|---------|----------|--------------------------------------|
| `query`       | string  | Yes      | The search query string              |
| `max_results` | integer | No       | Max results to return (default 5, max 10) |

**Response** — JSON object with a `results` array. Each result contains:

| Field    | Type   | Description                       |
|----------|--------|-----------------------------------|
| `title`  | string | Title of the web page             |
| `url`    | string | URL of the web page               |
| `content`| string | Relevant content snippet          |

### cURL Example

```bash
curl https://ollama.com/api/web_search \
  --header "Authorization: Bearer $OLLAMA_API_KEY" \
  -d '{"query":"what is ollama?"}'
```

### Python SDK

```python
from ollama import web_search

results = web_search("What is Ollama?")
for r in results:
    print(r.title, r.url, r.content)
```

### JavaScript SDK

```javascript
import { Ollama } from "ollama";

const client = new Ollama();
const results = await client.webSearch("what is ollama?");
console.log(JSON.stringify(results, null, 2));
```

## Web Fetch API

Fetch a single web page by URL and return its content.

**`POST https://ollama.com/api/web_fetch`**

| Parameter | Type   | Required | Description            |
|-----------|--------|----------|------------------------|
| `url`     | string | Yes      | The URL to fetch       |

**Response** — JSON object containing:

| Field    | Type          | Description                  |
|----------|---------------|------------------------------|
| `title`  | string        | Title of the web page        |
| `content`| string        | Main content of the page     |
| `links`  | array[string] | Links found on the page      |

### cURL Example

```bash
curl --request POST \
  --url https://ollama.com/api/web_fetch \
  --header "Authorization: Bearer $OLLAMA_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"url": "ollama.com"}'
```

### Python SDK

```python
from ollama import web_fetch

result = web_fetch('https://ollama.com')
print(result.title, result.content, result.links)
```

### JavaScript SDK

```javascript
import { Ollama } from "ollama";

const client = new Ollama();
const fetchResult = await client.webFetch("https://ollama.com");
console.log(JSON.stringify(fetchResult, null, 2));
```

## Building a Search Agent

Use Ollama's web search as a tool with a model's tool-calling ability to build autonomous search agents. This example uses Qwen 3 with 4B parameters:

```bash
ollama pull qwen3:4b
```

```python
from ollama import chat, web_fetch, web_search

available_tools = {'web_search': web_search, 'web_fetch': web_fetch}

messages = [{'role': 'user', 'content': "what is ollama's new engine"}]

while True:
    response = chat(
        model='qwen3:4b',
        messages=messages,
        tools=[web_search, web_fetch],
        think=True
    )
    if response.message.thinking:
        print('Thinking: ', response.message.thinking)
    if response.message.content:
        print('Content: ', response.message.content)
    messages.append(response.message)
    if response.message.tool_calls:
        print('Tool calls: ', response.message.tool_calls)
        for tool_call in response.message.tool_calls:
            function_to_call = available_tools.get(tool_call.function.name)
            if function_to_call:
                args = tool_call.function.arguments
                result = function_to_call(**args)
                print('Result: ', str(result)[:200] + '...')
                messages.append({'role': 'tool', 'content': str(result)[:2000 * 4], 'tool_name': tool_call.function.name})
            else:
                messages.append({'role': 'tool', 'content': f'Tool {tool_call.function.name} not found', 'tool_name': tool_call.function.name})
    else:
        break
```

### Context Length

Web search results can return thousands of tokens. Increase the model's context length to at least ~32000 tokens for best results. Cloud models run at full context length automatically.

## MCP Server

The bundled script `scripts/web-search-mcp.py` exposes `web_search` and `web_fetch` as MCP tools via stdio. It uses the `ollama` Python package and supports both the FastMCP high-level API and the low-level `mcp.server.Server` fallback.

### Running the MCP Server

```bash
OLLAMA_API_KEY=your_key uv run scripts/web-search-mcp.py
```

The script declares its dependencies inline (PEP 723 metadata), so `uv run` resolves them automatically.

### Client Configuration

#### Cline / Claude Desktop

```json
{
  "mcpServers": {
    "web_search_and_fetch": {
      "type": "stdio",
      "command": "uv",
      "args": ["run", "path/to/web-search-mcp.py"],
      "env": { "OLLAMA_API_KEY": "your_api_key_here" }
    }
  }
}
```

#### OpenAI Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.web_search]
command = "uv"
args = ["run", "path/to/web-search-mcp.py"]
env = { "OLLAMA_API_KEY" = "your_api_key_here" }
```

#### Goose

Add via Goose's MCP server configuration UI with the same command/args/env.

### MCP Tools Exposed

| Tool         | Parameters                          | Description          |
|--------------|-------------------------------------|----------------------|
| `web_search` | `query` (str), `max_results` (int) | Search the web       |
| `web_fetch`  | `url` (str)                         | Fetch a web page     |

## Resources

- **`scripts/web-search-mcp.py`** — Ready-to-use MCP stdio server (bundled)
- **[Ollama Web Search Docs](https://docs.ollama.com/capabilities/web-search)** — Official documentation
- **[Python SDK Example](https://github.com/ollama/ollama-python/blob/main/examples/web-search.py)** — Python web search agent example
- **[JavaScript SDK Example](https://github.com/ollama/ollama-js/blob/main/examples/websearch/websearch-tools.ts)** — JS web search agent example