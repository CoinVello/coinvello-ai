# CoinVello reference server (mock)

A small Express + TypeScript server that mimics `https://api.coinvello.com/v1` closely enough
to develop and CI-test plugins, SDKs and checkout integrations **offline**, with no CoinVello
account. It implements:

| Area | Endpoints |
|------|-----------|
| Invoices | `POST/GET /invoices`, `GET/PATCH /invoices/{id}`, `/cancel`, `/expire`, `/payments` |
| Payments | `GET /payments`, `GET /payments/{id}` |
| Checkout | `POST/GET /checkout-sessions` (+ `/checkout_sessions` alias), `GET /{id}?expand=invoice`, `/expire` |
| Public checkout (no auth, CORS `*`) | `GET /checkout-sessions/{id}/public` (also accepts `cpu_` ids, `purpose: credits`), `GET /checkout-sessions/{id}/events` (SSE: `status` on every change + `heartbeat` every 15 s; driven by `simulate_payment`, expire, cancel) |
| Webhooks | CRUD, `/rotate_secret`, `/test`, `/deliveries`, `/deliveries/{id}/retry` - **real HMAC-SHA256 signing and HTTP delivery** |
| Credits | `GET /credits/balance`, `GET /credits/bundles` (with crypto prices), `POST/GET /credits/purchases`, `/cancel`, `GET /credits/ledger` |
| Rates / assets | `GET /rates`, `GET /assets` |
| Events | `GET /events`, `GET /events/{id}` |
| Records and exports | `GET /records`, `/records/summary`, `/records/{id}`; `POST/GET /exports`, `GET/DELETE /exports/{id}`, `GET /exports/{id}/download`; `tax` on invoices and checkout sessions; `records` settings on `GET/PATCH /account`; the `export.ready` webhook (see below) |
| Testing | `POST /test/simulate_payment` for invoices (`inv_`) **and** credit purchases (`cpu_`) |
| Extras | `GET /health`; `POST/GET /webhook-sink` - a built-in receiver that logs signed deliveries |

Not implemented (return 404): wallets CRUD (one mock wallet per chain is pre-registered),
rates quotes/locks, conversions, off-ramp, refunds, auth, admin. The error envelope,
idempotency replay, cursor pagination and header conventions all match the spec.

## Records and exports

Every confirmed payment writes a `payment_received` record (`contract_value` from the invoice's locked rate, `value` 5 bps lower so the two columns differ), every credit debit a `fee_prepaid` record and every credit purchase a `credit_purchase` record, as the design in `docs/10-records-and-tax.md` describes. How the mock differs from production:

- **Rows are simulated.** Everything on the mock comes from `/test/simulate_payment`, so the spec's `include_simulated` (default `false`) hides all of it: pass `include_simulated=true` to `GET /records`, `GET /records/summary` and `POST /exports`.
- **Exports are built inside the request** and come back `ready`, with the file in memory; `queued`/`processing`/`failed` never occur. `GET /exports/{id}/download` streams the file with `200` (production redirects with `302`); `download_url` is a signed link on this server that needs no API key. The 7-day expiry (`expired`, `409 export_expired`) is enforced; the 20-per-hour and 2-running limits are not.
- **Formats:** CSV (UTF-8 BOM, §4.3 columns), XLSX through `exceljs` (Read me, Summary and one sheet per dataset), JSON; `dataset: all` gives one workbook, or a zip of stored files with `manifest.json` and `README.txt`. Presets `journal`, `quickbooks`, `xero`, `koinly`, `cointracker` and `coinledger` fit `records` + `csv` only (`422 invalid_export_combination` otherwise). Their vendor headers follow design §4.4 and were not re-verified against the vendors' current templates.
- **Datasets** without a mock behind them (`refunds`, `sweeps`, `conversions`, `offramp_payouts`) export a header row and no data. Customer details never leave: the invoices export keeps only `customer.reference`.

## Run

```bash
cd api/reference-server
npm install
npm run dev          # tsx watch, http://localhost:4242/v1
# or
npm start
```

Any API key beginning with `cv_test_` is accepted. `cv_live_` keys get `403`.

Environment: `PORT` (4242), `PAY_BASE_URL` (default `https://pay.coinvello.com`, used for
`hosted_url` / `checkout_url`), `QUIET=1` to silence delivery logs.

## Quick tour

```bash
B=http://localhost:4242/v1; K="Authorization: Bearer cv_test_local"

# webhook to the built-in sink (or your own http://localhost:3000/... handler)
curl -s $B/webhooks -H "$K" -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:4242/v1/webhook-sink","events":["*"]}'

# invoice
INV=$(curl -s $B/invoices -H "$K" -H 'Content-Type: application/json' \
  -d '{"amount":"49.99","currency":"USD","accepted_assets":["btc:bitcoin","usdt:tron"],"order_id":"WC-1"}' | jq -r .id)

# pay it: detected (0 conf) then confirmed
curl -s $B/test/simulate_payment -H "$K" -H 'Content-Type: application/json' \
  -d "{\"invoice_id\":\"$INV\",\"asset\":\"usdt:tron\",\"confirmations\":0,\"tx_hash\":\"demo\"}" | jq .invoice.status
curl -s $B/test/simulate_payment -H "$K" -H 'Content-Type: application/json' \
  -d "{\"invoice_id\":\"$INV\",\"asset\":\"usdt:tron\",\"confirmations\":19,\"tx_hash\":\"demo\"}" | jq .invoice.status

# what was delivered (signature header + body)
curl -s $B/webhook-sink -H "$K" | jq '.data[0] | {signature, type: .body.type}'

# buy credits
curl -s $B/credits/purchases -H "$K" -H 'Content-Type: application/json' \
  -d '{"bundle_id":"bnd_growth_15000","pay_asset":"usdt","pay_chain":"tron"}' | jq '{id, checkout_url, opt: .payment.payment_options[0].payment_uri}'
```

## Behaviour notes

* Payment matching: `simulate_payment` with the same `tx_hash` updates the existing payment's
  confirmations; a new hash adds another payment. Multiple partial payments accumulate.
  `amount` below the invoice amount (minus 0.5 % tolerance) leaves the invoice `pending`
  until it expires, then `underpaid`; above +2 % gives `overpaid`.
* Fees: when an invoice reaches paid/underpaid/overpaid the mock debits `clamp(round(fiat_usd x 0.30), 2, 2000)` credits
  (30 bps nominal, 1 credit = $0.01) exactly like production, and records `fee` on the invoice. Creating an invoice
  reserves its estimated fee (`GET /credits/balance` shows `balance`, `available`, `reserved`); the balance never goes
  below zero. Like production test mode the mock never runs out: when `available` cannot cover a new invoice it adds
  test credits (`bonus` ledger entry). Start it with `MOCK_CREDITS_RUN_OUT=1` to get `402 insufficient_credits`
  (`details: { available, required, bundles_url }`) instead, as a live prepaid account without pay as you go would.
  `account.auto_switch_to_pay_as_you_go` (default true) is stored and returned, but the mock does not switch plans.
  The mock starts with 1000 credits; buy more with `/credits/purchases` + `simulate_payment` (bundles seeded from
  docs/03-fees-and-credits.md).
* Webhooks are delivered synchronously inside the request that caused them (so your handler
  has already been called when `simulate_payment` returns). Failed deliveries are recorded
  with `next_retry_at` but the mock does **not** retry automatically; use `.../retry`.
* Rates are static (see `src/store.ts`), addresses and tx hashes are random but well-formed.
* State is in memory; restart to reset.

## Smoke test

```bash
npm run smoke
```

Boots the app on a random port and exercises invoice -> payment -> webhook -> signature
verification -> checkout -> credit purchase. Use it as a template for plugin CI.

## Using from the SDKs

```ts
new CoinVello("cv_test_local", { baseUrl: "http://localhost:4242/v1" })
```
```php
new \CoinVello\Sdk\Client('cv_test_local', ['base_url' => 'http://localhost:4242/v1'])
```
```python
CoinVello("cv_test_local", base_url="http://localhost:4242/v1")
```
