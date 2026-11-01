# @coinvello/mcp

Model Context Protocol server for the [CoinVello](https://coinvello.com) API, the non-custodial crypto
payment processor (no KYC, merchant keeps the keys, fees as prepaid credits, 11 networks).

Give Claude, Cursor, Windsurf, ChatGPT or any MCP client the ability to create checkout sessions,
inspect invoices and payments, register webhooks, verify webhook signatures, manage credits and
simulate test payments while it writes your integration.

```bash
npx -y @coinvello/mcp            # stdio (what every desktop client uses)
npx -y @coinvello/mcp --http 3333  # Streamable HTTP on http://127.0.0.1:3333/mcp
```

```bash
# from a checkout of this repo instead
npm install && npm run build && node dist/index.js
```

### Hosted (nothing to install)

`https://mcp.coinvello.com/mcp` runs this server for you over Streamable HTTP. Send your own key with every request
as `Authorization: Bearer cv_test_...` (or `X-CoinVello-Api-Key`, or an `api_key` setting in clients that only take
query parameters). The hosted server stores nothing, accepts test keys only, and never logs keys. Run it yourself with
`npx -y @coinvello/mcp --http --hosted`.

```json
{ "mcpServers": { "coinvello": { "url": "https://mcp.coinvello.com/mcp", "headers": { "Authorization": "Bearer cv_test_..." } } } }
```

## Documentation

| | |
|---|---|
| Website and setup for AI assistants | https://coinvello.com/ai |
| Complete integration guide (one file, written for LLMs) | https://coinvello.com/llms-full.txt |
| Developer docs and SDKs | https://coinvello.com/developers |
| OpenAPI 3.1 reference | https://coinvello.com/.well-known/openapi.yaml |
| MCP Registry | `io.github.CoinVello/coinvello` |
| Source | https://github.com/CoinVello/coinvello-ai (`api/ai/mcp-server`) |
| Support | support@coinvello.com |

## Configuration

| Variable | Required | Meaning |
|----------|----------|---------|
| `COINVELLO_API_KEY` | yes | `cv_test_...` from https://coinvello.com/app/settings.php (Settings -> API keys). Any `cv_test_` string works against the local mock. |
| `COINVELLO_API_BASE` | no | Default `https://api.coinvello.com/v1`. Use `http://localhost:4242/v1` for the reference mock server. |
| `COINVELLO_ALLOW_LIVE` | no | The server **refuses to start with a `cv_live_` key** unless this is `1`. Agents should develop against test mode. |
| `COINVELLO_API_VERSION` | no | Pins `CoinVello-Version` (default: account version, currently `2026-10-01`). |

## Client setup

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "coinvello": {
      "command": "npx",
      "args": ["-y", "@coinvello/mcp"],
      "env": { "COINVELLO_API_KEY": "cv_test_..." }
    }
  }
}
```

### Claude Code

```bash
claude mcp add coinvello -e COINVELLO_API_KEY=cv_test_... -- npx -y @coinvello/mcp
```

or in `.mcp.json` at the project root (shared with the team, key via env):

```json
{
  "mcpServers": {
    "coinvello": {
      "command": "npx",
      "args": ["-y", "@coinvello/mcp"],
      "env": { "COINVELLO_API_KEY": "${COINVELLO_API_KEY}" }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "coinvello": {
      "command": "npx",
      "args": ["-y", "@coinvello/mcp"],
      "env": { "COINVELLO_API_KEY": "cv_test_..." }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "coinvello": {
      "command": "npx",
      "args": ["-y", "@coinvello/mcp"],
      "env": { "COINVELLO_API_KEY": "cv_test_..." }
    }
  }
}
```

### VS Code (Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "coinvello": { "type": "stdio", "command": "npx", "args": ["-y", "@coinvello/mcp"], "env": { "COINVELLO_API_KEY": "cv_test_..." } }
  }
}
```

### Remote / HTTP clients (ChatGPT connectors, hosted agents)

Run `coinvello-mcp --http 3333` behind your own HTTPS reverse proxy and point the client at
`https://your-host/mcp`. The HTTP mode is stateless (one server instance per request) and binds to
`127.0.0.1` by default (`MCP_HTTP_HOST=0.0.0.0` to change). It uses the key from the environment,
so put it behind authentication: it is meant for your own agents, not the public.

## Tools

| Tool | Does |
|------|------|
| `create_checkout_session` | `POST /checkout-sessions`: hosted payment page; returns `url` to redirect to and `invoice_id` |
| `get_invoice` | `GET /invoices/{id}` (or `GET /checkout-sessions/{cs_id}?expand=invoice`) |
| `list_invoices` | `GET /invoices` with status / order_id / email filters |
| `list_payments` | `GET /payments` with invoice_id / status / chain / tx_hash filters |
| `create_wallet` | `POST /wallets` (xpub for BTC, address for EVM/Solana/Tron). Refuses xprv locally. |
| `list_wallets` | `GET /wallets` |
| `create_webhook` | `POST /webhooks`; returns the `whsec_` secret once |
| `verify_webhook_signature` | Local HMAC check of a `CoinVello-Signature` header against a raw body (no API call) |
| `get_credits_balance` | `GET /credits/balance` |
| `list_credit_bundles` | `GET /credits/bundles` |
| `create_credit_purchase` | `POST /credits/purchases`; returns payment options + `checkout_url` |
| `get_rates` | `GET /rates` |
| `list_assets` | `GET /assets` (optional chain filter) |
| `simulate_test_payment` | `POST /test/simulate_payment` (test keys only) |
| `list_records` | `GET /records`: the book of record (payments, fees, credit purchases) valued when they happened; filters type / asset / chain / invoice / order / tx / dates / currency |
| `get_records_summary` | `GET /records/summary`: sales, market value received, refunds, fees, net received for a period, optionally grouped |
| `create_export` | `POST /exports`: CSV, Excel or JSON file of records or any dataset (QuickBooks, Xero, Koinly, CoinTracker, CoinLedger presets); returns the export with `download_url` |
| `get_export` | `GET /exports/{id}`: poll status until `ready`, read `file.sha256` and `download_url` |

Every tool returns the raw API JSON (also as `structuredContent`). API errors come back as tool errors
containing `http_status`, the CoinVello `error` envelope (`type`, `code`, `message`, `request_id`) and a `hint`.

## Resources

| URI | Content |
|-----|---------|
| `coinvello://docs/llms-full.txt` | Complete single-file integration guide (auth, checkout, redirect, webhook verification, polling, credits, errors, examples in curl/Node/Python/PHP) |
| `coinvello://docs/llms.txt` | Short llms.txt index |
| `coinvello://openapi.yaml` | OpenAPI 3.1 specification |

Documents are bundled at build time; if missing they are fetched from coinvello.com.

## Prompts

`integrate-coinvello-into-<framework>` for `nextjs`, `express`, `fastapi`, `flask`, `django`,
`laravel`, `rails`, `sinatra`, `go`, `woocommerce`, `shopify`, `generic`, plus
`integrate-coinvello-into-framework` with a free-form `framework` argument. Optional arguments:
`currency`, `assets`. Each prompt tells the agent to read the guide resource, add a checkout route, a
raw-body webhook route with signature verification and `event.id` dedupe, and to verify end to end
with `simulate_test_payment`.

## Typical agent session

1. `list_assets` -> pick assets the merchant can accept.
2. `create_webhook` with the app's `/webhooks/coinvello` URL -> store the secret in the env file.
3. Write the code (see the `integrate-coinvello-into-*` prompt or `api/ai/cookbook`).
4. `create_checkout_session` -> `simulate_test_payment` on `invoice_id` with enough confirmations.
5. `get_invoice` shows `paid`; the app's webhook handler was called with a real signed event.
6. `verify_webhook_signature` to debug a handler that rejects deliveries.
7. Bookkeeping: `list_records` (with `include_simulated: true` in test mode) -> `get_records_summary` for a period -> `create_export` (`format: "xlsx"`) -> `get_export` until `ready` -> download the `download_url` and check `file.sha256`.

## Development

```bash
npm install
npm run build          # copies docs into dist/docs and compiles TypeScript
npm test               # smoke test against the mock: needs api/reference-server running on :4242
npm run dev            # tsx src/index.ts (stdio)
```

Smoke test: `cd api/reference-server && npm install && npm start`, then
`COINVELLO_API_BASE=http://localhost:4242/v1 npm test` here. It exercises all 18 tools, the three
resources and the prompts, verifies a real signed delivery captured by the mock's webhook sink, and
checks the xprv guard. The mock does not implement wallet CRUD, so `create_wallet` / `list_wallets`
are expected to return a clean 404 tool error there.

## Security notes

- Keep the server on test keys while an agent is writing code. `COINVELLO_ALLOW_LIVE=1` is a deliberate opt-in.
- The server never logs the API key or webhook secrets. Tool output does include `secret` from `create_webhook` because that is the only time the API returns it.
- `create_wallet` rejects anything that looks like an extended private key before it leaves the machine.
- Nothing here moves funds: CoinVello is non-custodial, and the API has no "send" operation.

License MIT. Source: https://github.com/CoinVello/coinvello-ai (mirror). Issues: https://github.com/CoinVello/coinvello-ai/issues or support@coinvello.com
