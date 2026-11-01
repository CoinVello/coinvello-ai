# CoinVello API cheatsheet

Base `https://api.coinvello.com/v1` · `Authorization: Bearer cv_test_... | cv_live_...` · JSON · version `2026-10-01`
Mock: `http://localhost:4242/v1` (api/reference-server; any `cv_test_` key; no wallet CRUD).

## Conventions

| Thing | Rule |
|-------|------|
| Amounts | Decimal **strings**: `"49.99"`, `"0.00074230"`. Never floats. |
| Asset ids | `<asset>:<chain>`: `btc:bitcoin`, `eth:ethereum`, `eth:base`, `eth:arbitrum`, `eth:optimism`, `pol:polygon`, `bnb:bnb`, `avax:avalanche`, `eth:robinhood`, `sol:solana`, `trx:tron`, `usdc:{ethereum,base,arbitrum,optimism,polygon,bnb,avalanche,solana}`, `usdt:{ethereum,base,arbitrum,optimism,polygon,bnb,avalanche,solana,tron}`, `dai:{ethereum,base,arbitrum,optimism,polygon}`, `eurc:{ethereum,base,avalanche,solana}`, `pyusd:ethereum`, `usdg:robinhood`, `wbtc:{ethereum,base,arbitrum,optimism,polygon}`, `cbbtc:{ethereum,base,arbitrum,solana}`, `btcb:{bnb,avalanche}`. Live-only (no testnet contract): all `dai:*`, `wbtc:*`, `cbbtc:*`, `btcb:*`, `usdc:bnb`, `usdt:{base,arbitrum,optimism,avalanche,solana}` (`GET /assets` is authoritative) |
| Chains | bitcoin, ethereum, base, arbitrum, optimism, polygon, bnb, avalanche, robinhood, solana, tron |
| Ids | `inv_` invoice, `pay_` payment, `wal_` wallet, `whe_` webhook, `evt_` event, `cs_` checkout session, `cpu_` credit purchase, `rf_` refund, `rec_` record, `exp_` export |
| Idempotency | `Idempotency-Key: <string <= 255>` on every POST; same key + same body replays, same key + different body -> 409 `idempotency_key_reused` |
| Lists | `?limit=20&cursor=...` -> `{ "object":"list", "data":[...], "has_more":bool, "next_cursor":string|null }` |
| Errors | `{ "error": { "type", "code", "message", "param?", "request_id", "doc_url?", "details?" } }` |
| Rate limit | 100 req/s per key; 429 + `Retry-After` |
| Test mode | Separate universe; testnets; test credits never run out; `POST /test/simulate_payment` |

## Core endpoints

| Method & path | Purpose | Key fields |
|---------------|---------|-----------|
| `POST /checkout-sessions` | Hosted payment page | req: `amount`, `currency`, `success_url` (+ all invoice fields, `line_items[]`, `redirect_on`, `branding`, `locale`) -> `id cs_`, `url`, `invoice_id`, `status open|complete|expired`, `invoice_status`, `expires_at` |
| `GET /checkout-sessions/{id}?expand=invoice` | Status + embedded invoice | |
| `POST /checkout-sessions/{id}/expire` | Close early | |
| `GET /checkout-sessions/{id}/public`, `.../events` | Public (no auth, CORS *) projection and SSE stream used by the hosted page / widget | |
| `POST /invoices` | Bare invoice (own UI) | req: `amount`, `currency` (fiat or asset id), `accepted_assets[]`, `order_id`, `description`, `customer{email,name,reference}`, `success_url`, `cancel_url`, `expires_in` 300..86400 (1800), `rate_lock` (true), `required_confirmations{}`, `underpayment_tolerance` ("0.005"), `overpayment_tolerance` ("0.02"), `payment_options_mode all|single`, `metadata{}` -> `id inv_`, `status`, `hosted_url`, `payment_options[]`, `paid{}`, `rate_lock{}`, `expires_at` |
| `GET /invoices`, `GET /invoices/{id}` | List (`status`, `order_id`, `customer_email`, `created[gte|lte]`) / fetch | |
| `PATCH /invoices/{id}` | Update `metadata`, `description` | |
| `POST /invoices/{id}/cancel`, `/expire` | State changes | |
| `GET /invoices/{id}/payments`, `GET /payments`, `GET /payments/{id}` | On-chain payments: `tx_hash`, `amount`, `amount_fiat`, `status detected|confirming|confirmed|failed`, `confirmations`, `required_confirmations` | |
| `POST /wallets`, `GET /wallets`, `GET/PATCH/DELETE /wallets/{id}` | Merchant wallets | req: `type xpub|address`, `chain`, `label`, `xpub`/`derivation_path`/`address_type`/`start_index` or `address`/`assets[]` -> `status unverified|verified|archived`; PATCH `assets` needs 1+ ids listed by `GET /assets` for the wallet's mode |
| `POST /wallets/{id}/verification`, `POST /wallets/{id}/verify` | Optional ownership proof (never required) | |
| `GET /wallets/{id}/addresses` | Derived addresses | |
| `POST /webhooks`, `GET /webhooks`, `GET/PATCH/DELETE /webhooks/{id}` | Endpoints | req: `url`, `events[]` or `["*"]`, `description` -> `secret whsec_` (once), `status active|degraded|disabled` |
| `POST /webhooks/{id}/test`, `/rotate_secret`, `GET .../deliveries`, `POST .../deliveries/{id}/retry` | Testing, rotation, delivery log | |
| `GET /credits/balance` | `balance` (= `available` + `reserved`, never negative), `available`, `reserved`, `low_balance_threshold`, `estimated_payments_remaining`, `auto_topup{}` | |
| `GET /credits/bundles` | `id`, `name`, `credits`, `bonus_credits`, `price{amount,currency}`, `price_per_credit`, `crypto_prices[]` | |
| `POST /credits/purchases`, `GET /credits/purchases[/{id}]`, `POST .../cancel` | Buy credits in crypto, or by card | req: `bundle_id` + `pay_asset` (symbol, e.g. `usdt`), `pay_chain`, or `bundle_id` + `payment_method` (`pm_`, card saved in the dashboard) -> `id cpu_`, `status`, `credits`, `payment.payment_options[]`, `checkout_url` |
| `GET /credits/ledger`, `PUT /credits/auto_topup` | History, auto top-up | |
| `GET /rates?base=USD&assets=` | Indicative rates | |
| `POST /rates/quotes`, `POST /rates/locks`, `GET /rates/locks/{id}` | Binding quotes (attach `rate_lock_id` to invoice) | |
| `GET /assets` | Assets of one mode (the key's; without a key, header `CoinVello-Livemode: true` or `false`, default live) with `decimals`, `contract_address`, `required_confirmations`, `min_amount`, `wallet_type` | |
| `GET /events`, `GET /events/{id}` | Event log (backfill after outage) | |
| `POST /test/simulate_payment` | Test keys only | req: `invoice_id` (`inv_` or `cpu_`), `asset`, `amount`, `confirmations`, `tx_hash`, `delay_seconds` |
| `POST /refunds`, `GET /refunds/{id}`, `POST .../submit`, `/cancel` | Refunds (merchant signs; CoinVello prepares) | |
| `/conversions/*`, `/offramp/*` | Optional non-custodial swaps and partner off-ramp | |
| `GET /records`, `GET /records/{id}` | Book of record, newest first (`rec_`): `type payment_received|fee_prepaid|credit_purchase|refund_sent|...`, `occurred_at`, `received/sent/fee{asset,amount}`, `contract_value` (locked rate) and `value` + `value_usd` (market at block time), `tax`, `invoice` snapshot, `flags` | filters `type`, `asset`, `chain`, `invoice_id`, `order_id`, `tx_hash`, `occurred_gte|lte`, `currency`, `include_simulated` (test keys) |
| `GET /records/summary` | Period totals: `sales`, `received_market_value`, `valuation_difference`, `tax_collected`, `refunds`, `fees_prepaid`, `credits_consumed`, `fees_onchain`, `network_fees`, `credit_purchases`, `net_received` | req: `period_start` (incl.), `period_end` (excl.); `timezone`, `currency`, `group_by month|asset|chain|type|address` |
| `POST /exports`, `GET /exports`, `GET/DELETE /exports/{id}`, `GET /exports/{id}/download` | CSV / Excel / JSON files, kept 7 days | req: `format csv|xlsx|json`; `dataset` (records), `preset` (generic, journal, quickbooks, xero, koinly, cointracker, coinledger: records + csv only, else 422), `period{start,end}` or null, `timezone`, `currency`, `include_simulated` -> `status queued|processing|ready|failed|expired`, `file{name,content_type,bytes,sha256}`, `download_url`; `409 export_not_ready|export_expired|export_failed` on download |
| `PATCH /account { billing_plan, auto_switch_to_pay_as_you_go }` | `prepaid` / `pay_as_you_go`; auto switch (default true) moves a prepaid account to pay as you go when credits run out | |
| `PATCH /account { records }` | `reporting_currency`, `fiscal_year_start` (MM-DD), `timezone` | `tax{amount,rate,label,jurisdiction}` on invoice / session creation (included in `amount`) |

## Invoice status machine

`new` -> `pending` (payment seen, insufficient or 0 conf) -> `confirming` (enough paid, waiting for
confirmations) -> `paid` (fulfil). Alternatives: `underpaid`, `overpaid` (outside tolerances),
`expired`, `cancelled`, `refund_requested`. Terminal: paid, underpaid, overpaid, expired, cancelled.
Checkout session: `open` -> `complete` | `expired`; `invoice_status` carries the money state.

## Webhook

Header `CoinVello-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`; signed `"<t>.<raw body>"`; HMAC-SHA256 with
the `whsec_` secret (UTF-8, prefix included); 300 s tolerance; constant-time compare; any `v1` may match;
dedupe on `event.id`; respond 2xx in 10 s. Retries 1m, 5m, 30m, 2h, 6h, 12h, 24h, 24h. Not ordered.

Event body: `{ id evt_, object:"event", type, livemode, api_version, created_at, data:{ object, previous_attributes? }, request:{id, idempotency_key}, pending_webhooks }`.

Types: `invoice.created|pending|confirming|paid|underpaid|overpaid|expired|cancelled|refund_requested`,
`payment.detected|confirmed|failed`, `wallet.verified`, `checkout_session.completed|expired`,
`credits.low|added`, `credits.purchase.paid|underpaid|expired`, `refund.completed|failed`,
`conversion.completed|failed`, `offramp.completed|failed`, `export.ready|failed`.

## Error codes to handle

| HTTP | type / code | Action |
|------|-------------|--------|
| 400 | `invalid_request_error` / `parameter_missing`, `parameter_invalid`, `parameter_unknown`, `amount_too_small`, `currency_unsupported`, `metadata_too_large` | Fix request |
| 401 | `authentication_error` / `api_key_missing|invalid|revoked|expired` | Check key |
| 402 | `credits_error` / `insufficient_credits` (`details.available`, `details.required`, `details.bundles_url`) | Buy credits or use pay as you go |
| 403 | `permission_error` / `insufficient_scope`, `test_mode_only`, `live_mode_only`, `merchant_suspended`, `ip_not_allowed` | Key/mode |
| 404 | `invalid_request_error` / `resource_missing` | Wrong id or mode |
| 409 | `invalid_state`, `quote_expired`, `rate_lock_expired`; `idempotency_error` / `idempotency_key_reused`, `idempotency_key_in_progress` | Retry only `in_progress` |
| 422 | `asset_not_enabled`, `xpub_required`, `xpub_invalid`, `xprv_rejected`, `address_invalid`, `derivation_path_invalid`, `url_insecure` | Fix wallet/config |
| 429 | `rate_limit_error` | Back off (`Retry-After`) |
| 5xx | `api_error`, `chain_error`, `partner_error` | Retry with backoff, same idempotency key |

## Fees in one breath

Prepaid processing credits, 1 credit = $0.01 nominal, a confirmed payment consumes ~30 bps of its fiat
value (floor 2, cap 2,000 credits). Bundles (indicative): Starter 2,500/$25 (0.30%),
Growth 15,000/$120 (0.24%), Scale 75,000/$450 (0.18%), Volume 400,000/$1,600 (0.12%), Enterprise
2M+/from $6,000 (<=0.09%). Credits last 24 months. Bought in crypto or by card via `POST /credits/purchases`.
No free live credits; the balance never goes below zero (open invoices reserve their estimated fee).
Without credits: pay as you go (0.4% split on-chain, open to every account, not on Bitcoin); auto switch to it is on by default.
