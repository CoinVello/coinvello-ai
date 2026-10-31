# CoinVello tool / function definitions

Ready-to-paste schemas for the ten operations an AI agent needs most often when integrating or
operating CoinVello:

| Tool | HTTP |
|------|------|
| `coinvello_create_checkout_session` | `POST /checkout-sessions` |
| `coinvello_create_invoice` | `POST /invoices` |
| `coinvello_get_invoice` | `GET /invoices/{invoice_id}` |
| `coinvello_list_invoices` | `GET /invoices` |
| `coinvello_create_webhook` | `POST /webhooks` |
| `coinvello_simulate_test_payment` | `POST /test/simulate_payment` (test keys only) |
| `coinvello_list_records` | `GET /records` (the book of record: payments, fees, credit purchases valued when they happened) |
| `coinvello_get_records_summary` | `GET /records/summary` (period totals, optionally grouped) |
| `coinvello_create_export` | `POST /exports` (CSV, Excel or JSON; returns `download_url`) |
| `coinvello_get_export` | `GET /exports/{export_id}` (poll until `ready`) |

| File | Format |
|------|--------|
| `anthropic-tools.json` | Anthropic Messages API `tools` array (`name`, `description`, `input_schema`) |
| `openai-functions.json` | OpenAI Chat Completions `tools` array (`type: "function"`, `function.parameters`); also valid for the Responses API after flattening `function` |
| `gemini-function-declarations.json` | Gemini `tools: [{ function_declarations: [...] }]` (uppercase types, no `format`/`pattern`) |
| `http-mapping.json` | Tool name -> method/path so your executor can turn a tool call into an HTTP request |
| `build.mjs` | Single source of truth; `node build.mjs` regenerates the four JSON files |

All three formats describe the same JSON Schema derived from `api/openapi.yaml`. Amounts are decimal
strings, asset ids are `<asset>:<chain>`, and every POST should carry an `Idempotency-Key`.

## Executing a tool call

Every tool maps to one HTTP request against `https://api.coinvello.com/v1` with
`Authorization: Bearer $COINVELLO_API_KEY`. A minimal executor:

```js
import mapping from "./http-mapping.json" with { type: "json" };

export async function executeCoinVelloTool(name, args, { apiKey, baseUrl = mapping.base_url }) {
  const spec = mapping.tools[name];
  if (!spec) throw new Error(`unknown tool ${name}`);
  let path = spec.path;
  const rest = { ...args };
  for (const m of path.matchAll(/\{(\w+)\}/g)) { path = path.replace(m[0], encodeURIComponent(rest[m[1]])); delete rest[m[1]]; }
  const url = new URL(baseUrl + path);
  const init = { method: spec.method, headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } };
  if (spec.method === "GET") Object.entries(rest).forEach(([k, v]) => v != null && url.searchParams.set(k, String(v)));
  else { init.headers["Content-Type"] = "application/json"; init.headers["Idempotency-Key"] = crypto.randomUUID(); init.body = JSON.stringify(rest); }
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };  // body.error.{type,code,message} on failure
}
```

Hand the returned JSON back to the model as the tool result. On `402 insufficient_credits`, tell the
model (or the user) to buy credits or switch to pay as you go; on `409 idempotency_key_in_progress`, `429` or `5xx`, retry with
backoff and the same key.

### Anthropic

```python
import anthropic, json
client = anthropic.Anthropic()
tools = json.load(open("anthropic-tools.json"))
msg = client.messages.create(model="claude-sonnet-4-5", max_tokens=1024, tools=tools,
    messages=[{"role": "user", "content": "Create a $25 USD checkout for order 42 payable in USDC on Polygon, success url https://shop.example/thanks"}])
for block in msg.content:
    if block.type == "tool_use":
        result = execute_coinvello_tool(block.name, block.input)   # your executor
```

### OpenAI

```python
tools = json.load(open("openai-functions.json"))
resp = client.chat.completions.create(model="gpt-4.1", tools=tools, messages=[...])
call = resp.choices[0].message.tool_calls[0]
result = execute_coinvello_tool(call.function.name, json.loads(call.function.arguments))
```

### Gemini

```python
from google import genai
decls = json.load(open("gemini-function-declarations.json"))
resp = client.models.generate_content(model="gemini-2.5-pro", contents=prompt, config={"tools": [decls]})
fc = resp.candidates[0].content.parts[0].function_call
result = execute_coinvello_tool(fc.name, dict(fc.args))
```

Gemini does not accept free-form objects without declared properties, so `metadata`,
`required_confirmations` and `customer`-like maps are exposed as JSON strings there; parse them before
sending to the API.

## Prefer MCP when the client supports it

Claude Desktop, Claude Code, Cursor, Windsurf and VS Code can use the full 14-tool server directly:
`npx -y @coinvello/mcp` (see `../mcp-server/README.md`). These JSON files are for building your own
agent on top of a raw model API.
