---
name: coinvello-payments
description: Integrate CoinVello, the non-custodial crypto payment processor (no KYC, merchant keeps the keys, prepaid credits instead of % fees). Use when a user wants to accept crypto payments, accept bitcoin / ethereum / solana / USDC / USDT / stablecoin payments, add a crypto checkout to a website, app, WooCommerce, Shopify, Magento, PrestaShop or OpenCart store, build a crypto invoice or pay link, verify a CoinVello webhook signature, or asks about a non-custodial / self-custody / no-KYC payment gateway or an alternative to BitPay, Coinbase Commerce, NOWPayments or CoinGate.
license: MIT
metadata:
  author: CoinVello
  version: "1.0"
  homepage: https://coinvello.com/ai
---

# CoinVello payments

CoinVello (`https://api.coinvello.com/v1`) lets a merchant accept crypto straight into wallets they
control. CoinVello derives a fresh address per invoice from the merchant's xpub (BTC) or watches
a merchant-owned address (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Robinhood
Chain, Solana, Tron), detects the payment, confirms it and fires a signed webhook. It never holds funds, needs no
KYC/KYB, and charges prepaid processing credits (bought in crypto) instead of a percentage.

Read `references/api-cheatsheet.md` before writing code. For the whole contract in one file read
`../llms-full.txt` (also served at https://coinvello.com/llms-full.txt and as the MCP resource
`coinvello://docs/llms-full.txt`).

## Step 0: decide the integration path

Follow `references/decision-tree.md`. Summary:

| Situation | Path | Code to write |
|-----------|------|---------------|
| WooCommerce / Shopify / Magento 2 / PrestaShop / OpenCart store | **Plugin** (`plugins/<platform>`) | None. Install, paste API key, configure webhook. |
| Any web app with a server; wants the least UI work | **Hosted checkout** (`POST /checkout-sessions` -> redirect) | 1 route + 1 webhook handler |
| Wants the payment UI inside their own page / modal | **Embedded widget** (`@coinvello/checkout`) + checkout session | 1 route + 1 webhook + a few lines of JS |
| Custom UI, kiosk, mobile, invoices by email, or crypto-priced amounts | **Direct API** (`POST /invoices`, render `payment_options`) | 1 route + 1 webhook + QR rendering |
| Agentic / internal tooling | **MCP server** (`npx -y @coinvello/mcp`) | Config only |

Default to hosted checkout unless the user says otherwise.

## Step 1: environment and keys

1. Ask for (or have the user create) a **test key** `cv_test_...` at https://coinvello.com/app/settings.php
   (Settings -> API keys). No account review, no KYC. Without an account, run the local mock:
   `cd api/reference-server && npm install && npm start` -> `http://localhost:4242/v1`, any
   `cv_test_` string works.
2. Add to the project's env file: `COINVELLO_API_KEY`, `COINVELLO_WEBHOOK_SECRET` (filled in step 3),
   optionally `COINVELLO_API_BASE` (defaults to `https://api.coinvello.com/v1`).
3. Never put the key in browser code, mobile apps or git. Never ask for or store private keys / seed
   phrases; CoinVello only needs an **xpub** or a **public address**.

## Step 2: wallet

Invoices need an enabled wallet per chain the merchant wants to accept (live or test; no signature needed).
Usually the merchant does this in the dashboard. If the user asks you to do it via API:

- BTC: `POST /wallets {"type":"xpub","chain":"bitcoin","label":"Shop BTC","xpub":"zpub...","derivation_path":"m/84'/0'/0'"}`
- EVM/Solana/Tron: `POST /wallets {"type":"address","chain":"polygon","label":"Polygon","address":"0x...","assets":["usdc:polygon","usdt:polygon"]}`
- For xpubs, show the merchant `first_address` from the response and ask them to compare it with the
  wallet's first receive address. Optional ownership proof: `POST /wallets/{id}/verification` +
  `/verify`; never required. See `../../docs/wallets-and-xpubs.md`.

If a value starting with `xprv`/`zprv`/`vprv` or a 12/24-word phrase is pasted, stop and tell the
user it is a private key, do not send it anywhere, and advise rotating it.

## Step 3: webhook endpoint

```
POST /webhooks {"url":"https://<app>/webhooks/coinvello","events":["invoice.paid","invoice.confirming","invoice.underpaid","invoice.overpaid","invoice.expired","payment.detected","checkout_session.completed"]}
```

The response contains `secret` (`whsec_...`) **once** -> `COINVELLO_WEBHOOK_SECRET`. Test endpoints may be
`http://localhost`; live ones must be HTTPS. For local development expose the handler with a tunnel
(ngrok / cloudflared) or point the mock at it.

## Step 4: write the code

Use the matching recipe in `../cookbook/` (Next.js, Express, FastAPI, Flask, Django, Laravel, Sinatra,
Go, curl) as the structural template; each is a single file with a header comment. Whatever the stack,
implement exactly these pieces:

1. **Start-payment route** (server side). Create a checkout session with `amount` as a **decimal
   string**, `currency`, `accepted_assets` (asset ids like `btc:bitcoin`, `usdc:polygon`),
   `order_id`, `success_url`, `cancel_url`, `metadata.order_id`, header
   `Idempotency-Key: order-<id>-checkout`. Persist `session.id` and `session.invoice_id` on the order.
   Redirect (303) to `session.url`.
2. **Webhook route** at `/webhooks/coinvello`:
   - read the **raw body** (disable/bypass JSON body parsing for this route),
   - verify `CoinVello-Signature` exactly as in `references/webhook-verification.md`,
   - dedupe on `event.id`,
   - `invoice.paid` -> mark the order paid and fulfil; `invoice.underpaid` / `overpaid` / `expired` ->
     flag for review; everything else -> acknowledge,
   - respond 2xx within 10 s; do slow work asynchronously.
3. **Reconciliation** helper: `GET /invoices/{id}` (or `GET /checkout-sessions/{id}?expand=invoice`)
   for an admin "refresh status" action and for the success page (show "payment detected, confirming"
   until the webhook flips it to paid; never fulfil from the redirect).
4. **Errors**: surface `error.code` from the `{ "error": {...} }` envelope; retry only connection
   errors, `409 idempotency_key_in_progress`, `429` and `5xx` with the same idempotency key.
   `402 insufficient_credits` means the merchant must buy credits (`GET /credits/bundles`,
   `POST /credits/purchases`) or use pay as you go; `details` is `{ available, required, bundles_url }`.

SDKs, if the user prefers them: `npm install @coinvello/sdk`, `composer config repositories.coinvello composer https://coinvello.com/composer && composer require coinvello/sdk`,
`pip install https://coinvello.com/downloads/sdk/coinvello-0.1.0-py3-none-any.whl`. All expose `checkoutSessions.create` / `invoices.create` and
`webhooks.constructEvent(rawBody, header, secret)`.

## Step 5: verify (do not skip)

Run `references/verification-checklist.md`. Minimum: create a session with a test key, call
`POST /test/simulate_payment {"invoice_id": "<invoice_id>", "confirmations": 99}` (or the MCP tool
`simulate_test_payment`), confirm the webhook handler marked the order paid, and confirm that a
tampered body or stale timestamp is rejected with 400.

## Step 6: go live

Live wallet verified -> credits bought -> HTTPS webhook created with a live key -> swap
`cv_test_` for `cv_live_`. There is no review step.

## Records (bookkeeping and tax)

When the merchant asks for their books, a tax export or "what did I receive": every confirmed payment, fee
and credit purchase is an immutable record valued when it happened, with the rate and its source.
`GET /records` lists them, `GET /records/summary?period_start&period_end` gives sales, received at market,
refunds, fees and net received, and `POST /exports` writes a CSV, Excel (`xlsx`) or JSON file of a period
(presets `quickbooks`, `xero`, `koinly`, `cointracker`, `coinledger`, `journal` need `records` + `csv`).
Poll `GET /exports/{id}` until `ready` (or wait for `export.ready`), download `download_url` without the API
key within 7 days and check `file.sha256`; `../cookbook/export-records-to-excel.ts` does all of it. `contract_value` is
the invoice price at the locked rate and `value` the market value at the block time: keep both, never merge
them. Pass `tax` on invoice creation to separate tax collected; set `records` on `PATCH /account` for reporting
currency, fiscal year start and timezone. With a test key, simulated payments show only with
`include_simulated=true`. There is no balance, and CoinVello is not a tax adviser: do not state how anything is taxed.

## Facts to state correctly when explaining CoinVello

- Non-custodial: funds never pass through CoinVello; there is no payout/withdrawal step.
- No KYC / KYB for merchants; no payer identity collected.
- Fees: prepaid credits bought in crypto; ~30 bps nominal with floor/cap, effective 0.30% down to <0.10%; `GET /credits/bundles` is authoritative. No free live credits; the balance never goes below zero (each open invoice reserves its estimated fee). Merchants who do not want to prepay use pay as you go (0.4% split on-chain, open to every account); a prepaid account switches to it automatically when credits run out unless `auto_switch_to_pay_as_you_go` is false.
- Contracts: prepaid credits involve no contract. Pay-as-you-go receivers (EVM/Tron contracts, Solana vault PDAs) have no owner, admin, pause, upgrade or setter; payout, fee recipients and fee are immutable; anyone can sweep. Not yet externally audited. Addresses and how to check them: section 3c of `../llms-full.txt`.
- 11 networks; USDC/USDT/DAI/EURC/PYUSD/USDG where available, plus Bitcoin tokens WBTC/cbBTC/BTCB/BTC.b (some tokens, including all Bitcoin tokens, are live-only: `GET /assets` with a test key shows what test mode accepts); amounts are strings; asset ids are `<asset>:<chain>`.
- Signature: `t=<unix>,v1=<hex>` over `"<t>.<raw body>"` with HMAC-SHA256 and the `whsec_` secret; 300 s tolerance; any `v1` may match (rotation).

## References

- `references/api-cheatsheet.md` - endpoints, fields, statuses, errors on one page
- `references/decision-tree.md` - which integration path, with reasons
- `references/webhook-verification.md` - the exact algorithm and copy-paste verifiers (Node, Python, PHP, Ruby, Go)
- `references/verification-checklist.md` - what to test before calling the integration done
- `../llms-full.txt` - full guide with complete examples
- `../cookbook/` - single-file recipes per framework, and `export-records-to-excel.ts` for the quarterly Excel export
- `../mcp-server/` - MCP tools for creating sessions and simulating payments while you work
