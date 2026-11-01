# Records and exports

Every CoinVello account keeps a **book of record**: one immutable `record` for every movement of value
CoinVello observed on-chain or billed, valued in your reporting currency at the moment it happened, with the
rate and where it came from. It is what your accountant and your tax software need, and you can export all of
it, or any date range, as CSV, Excel or JSON at any time. The design, column definitions and the reasoning are
in `docs/10-records-and-tax.md`; this page is the API view.

There is no balance here. CoinVello never holds your money; records describe value that moved from a payer's
wallet to yours, from yours to a customer (refunds), or to CoinVello's fee address. CoinVello is not a tax
adviser: it records and exports, you and your adviser decide what is taxable where.

## What a record is

```json
{
  "id": "rec_3Kp9Qw2Xz7",
  "object": "record",
  "livemode": true,
  "type": "payment_received",
  "occurred_at": "2026-03-05T13:22:10Z",
  "recorded_at": "2026-03-05T13:22:41Z",
  "description": "Payment for invoice inv_9XyZ12AbC3 (order WC-10042)",
  "received": { "asset": "usdc:polygon", "amount": "49.990000", "amount_minor": "49990000" },
  "sent": null,
  "fee": null,
  "chain": "polygon",
  "tx_hash": "0x7f3a…", "tx_index": 112, "block_height": 65432100,
  "from_address": "0x9aB3…", "to_address": "0x4C1d…", "derivation_path": null,
  "explorer_url": "https://polygonscan.com/tx/0x7f3a…",
  "contract_value": { "currency": "USD", "amount": "49.99", "rate": "1.00000", "rate_as_of": "2026-03-05T13:10:02Z",
                      "source": { "provider": "invoice_rate_lock", "snapshot_id": "rl_auto_9XyZ12AbC3" } },
  "value": { "currency": "USD", "amount": "49.98", "rate": "0.99980", "rate_as_of": "2026-03-05T13:22:10Z",
             "source": { "provider": "coinvello_oracle", "method": "median", "venues": ["coinbase", "kraken", "binance"], "snapshot_id": "rs_8Hd2Kq4Lm" } },
  "value_usd": "49.98",
  "tax": { "amount": "7.98", "rate": "0.19", "label": "VAT 19%", "jurisdiction": "DE" },
  "credits": null,
  "invoice": { "id": "inv_9XyZ12AbC3", "status": "paid", "order_id": "WC-10042", "amount": "49.99", "currency": "USD", "pricing": "fiat", "customer_reference": "cus_88" },
  "related": { "payment_id": "pay_7Hq2kLm9Rt", "event_id": "evt_1Nz7Qw3Er9" },
  "reverses_record_id": null,
  "flags": [],
  "simulated": false,
  "metadata": { "woocommerce_order_id": "10042" }
}
```

* `received`, `sent` and `fee` are the legs of the movement in the asset's exact units. A fiat leg (an off-ramp
  payout, a card purchase of credits) uses the ISO code as `asset`.
* `value` is the **market value at `occurred_at`** (the block time) in your reporting currency, with the rate and
  its source. `value_usd` is the same in USD. `contract_value` is what the customer owed at the invoice's
  locked rate, when there was one. Both are kept because accountants differ on which to book; the summary
  reports both and their difference.
* `occurred_at` is when it happened on-chain; `recorded_at` is when CoinVello wrote it. Everything is bucketed
  by `occurred_at` in your timezone.
* Records are never edited. A payment that disappears in a reorg produces a `payment_reversed` record pointing
  at the original through `reverses_record_id`.
* `invoice` is a snapshot (status, order id, description, amount, currency, your `customer.reference`). No
  payer email or name is ever copied into a record or an export.

### Types

| `type` | Written when | Legs |
|---|---|---|
| `payment_received` | a payment reaches `confirmed` | `received` = the crypto |
| `payment_reversed` | a confirmed payment later fails (reorg, replacement) | `sent` = the same crypto; negates the original |
| `refund_sent` | a refund you signed completes | `sent` = the crypto, `fee` = network fee |
| `fee_prepaid` | credits are consumed (invoice, checkout, conversion, off-ramp, screening) | `credits`; `value` is the nominal $0.01 per credit |
| `fee_onchain` | a pay-as-you-go sweep confirms | `sent` = CoinVello's fee share; `fee` = network fee only if you triggered the sweep |
| `credit_purchase` | credits are added for a purchase | `sent` = the crypto paid, or a `USD` leg for a card |
| `credit_adjustment` | any other credit-ledger movement (bonus, promo, reversal, expiry, and the retired monthly grant) | `credits`; flagged `non_cash` |
| `conversion` | a conversion completes | `sent` and `received` = the two legs, `fee` = network fee |
| `offramp_payout` | an off-ramp payout completes | `sent` = the crypto, `received` = the fiat the partner paid |

Flags: `overpaid`, `underpaid`, `late` (paid after the invoice expired), `reversal`, `non_cash`, `simulated`,
`backfilled` (built from data older than the Records feature, valued at the invoice's locked rate).

## Reading records

```bash
# Everything that happened in Q3, newest first, valued in EUR
curl "https://api.coinvello.com/v1/records?occurred_gte=2026-07-01T00:00:00Z&occurred_lte=2026-09-30T23:59:59Z&currency=EUR&limit=100" \
  -H "Authorization: Bearer $COINVELLO_API_KEY"

# Just the fees
curl "https://api.coinvello.com/v1/records?type=fee_prepaid" -H "Authorization: Bearer $COINVELLO_API_KEY"
curl "https://api.coinvello.com/v1/records?type=fee_onchain" -H "Authorization: Bearer $COINVELLO_API_KEY"

# One invoice's history
curl "https://api.coinvello.com/v1/records?invoice_id=inv_9XyZ12AbC3" -H "Authorization: Bearer $COINVELLO_API_KEY"
```

Filters: `type`, `asset`, `chain`, `invoice_id`, `order_id`, `tx_hash`, `occurred_gte`, `occurred_lte`,
`currency` (re-values `value` from `value_usd` at the historical rate of each record's `occurred_at`),
`include_simulated` (test mode only). Standard cursor pagination (`docs/pagination.md`).

### Totals for a period

```bash
curl "https://api.coinvello.com/v1/records/summary?period_start=2026-01-01&period_end=2027-01-01&timezone=Europe/Berlin&currency=EUR&group_by=month" \
  -H "Authorization: Bearer $COINVELLO_API_KEY"
```

Returns `sales` (what you invoiced, at the locked rates), `received_market_value` (what the coins were worth
when they landed), `valuation_difference`, `tax_collected`, `refunds`, `fees_prepaid` and `credits_consumed`,
`fees_onchain`, `network_fees`, `credit_purchases`, `net_received`
(`received_market_value - refunds - fees_onchain - network_fees`) and counts, over `occurred_at` in the given
timezone, optionally grouped by `month`, `asset`, `chain`, `type` or `address`. `period_start` is inclusive,
`period_end` exclusive.

## Exports

An export is a file built from one dataset for a period, or for your entire history, in a format and column
layout of your choice. Create it, poll it or wait for the webhook, download it. Files are kept **7 days**; create
the export again whenever you need it.

```bash
# Last quarter, every record, Excel workbook (Read me + Summary + Records sheets)
curl -X POST https://api.coinvello.com/v1/exports \
  -H "Authorization: Bearer $COINVELLO_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "dataset": "records", "format": "xlsx",
        "period": { "start": "2026-07-01", "end": "2026-10-01" },
        "timezone": "America/New_York", "currency": "USD" }'

# Your whole history as generic CSV
curl -X POST https://api.coinvello.com/v1/exports -H "Authorization: Bearer $COINVELLO_API_KEY" \
  -H "Content-Type: application/json" -d '{ "dataset": "records", "format": "csv", "period": null }'

# A tax year in Koinly's universal format
curl -X POST https://api.coinvello.com/v1/exports -H "Authorization: Bearer $COINVELLO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "dataset": "records", "format": "csv", "preset": "koinly", "period": { "start": "2026-01-01", "end": "2027-01-01" } }'

# The year-end package: every dataset in one workbook
curl -X POST https://api.coinvello.com/v1/exports -H "Authorization: Bearer $COINVELLO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "dataset": "all", "format": "xlsx", "period": { "start": "2026-01-01", "end": "2027-01-01" } }'
```

The response is an `export` object (`exp_…`) with `status` `queued`, `processing`, `ready`, `failed` or
`expired`. Small exports come back `ready` at once; larger ones finish in the background. Then:

```bash
curl https://api.coinvello.com/v1/exports/exp_5Mn8Qr2Tv4 -H "Authorization: Bearer $COINVELLO_API_KEY"
# -> status: ready, rows: 1284, file: { name, content_type, bytes, sha256 }, download_url, download_expires_at

curl -L -o records.xlsx https://api.coinvello.com/v1/exports/exp_5Mn8Qr2Tv4/download -H "Authorization: Bearer $COINVELLO_API_KEY"
```

`GET /exports/{id}/download` redirects (`302`) to the signed `download_url`, or streams the file (`200`) where the server serves it directly; `409 export_not_ready`,
`export_expired` or `export_failed` otherwise. `DELETE /exports/{id}` removes a file early. The webhooks
`export.ready` and `export.failed` carry the export object. Verify the file against `file.sha256`.

| Parameter | Values |
|---|---|
| `dataset` | `records` (default), `invoices`, `payments`, `refunds`, `sweeps`, `credit_ledger`, `credit_purchases`, `conversions`, `offramp_payouts`, `all` |
| `format` | `csv` (RFC 4180, UTF-8 with BOM, ISO timestamps with offset), `xlsx` (fiat values numeric; crypto amounts, hashes and ids as text), `json` (the API objects) |
| `preset` | `records` only: `generic` (every column), `journal` (double-entry rows), `quickbooks` and `xero` (bank-feed CSV), `koinly`, `cointracker`, `coinledger` (universal import templates). Vendor presets are CSV only. |
| `period` | `{ "start", "end" }` in the export's timezone, start inclusive, end exclusive; `null` or omitted for everything |
| `timezone`, `currency` | default to the account's records settings |
| `include_simulated` | test mode only, default `false` |

Limits: 20 exports per hour, 2 running at a time, no row cap (files are streamed). With `all`, `xlsx` gives one
workbook with a sheet per dataset; `csv` and `json` give a zip with one file per dataset, a `manifest.json`
(hashes, row counts) and a `README.txt`.

## Account settings and the invoice `tax` field

```bash
# Reporting currency, fiscal year start and timezone used by summaries and exports
curl -X PATCH https://api.coinvello.com/v1/account -H "Authorization: Bearer $COINVELLO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "records": { "reporting_currency": "GBP", "fiscal_year_start": "04-06", "timezone": "Europe/London" } }'
```

Stored values never change when you switch currency: `value` is re-derived from `value_usd` at the historical
rate; `value_usd` and the original rate stay on the record.

To split sales from the tax you collected, pass the tax portion when creating an invoice or checkout session.
It is in the invoice currency, included in `amount`, and `jurisdiction` is a region code you choose; nothing
about the payer is involved.

```json
{ "amount": "49.99", "currency": "EUR", "tax": { "amount": "7.98", "rate": "0.19", "label": "VAT 19%", "jurisdiction": "DE" } }
```

The WooCommerce plugin fills `tax` from the order; the other plugins follow.

## Scopes and test mode

Restricted keys use `records:read`, `exports:read` and `exports:write`. Test-mode keys see test-mode records
(including rows from `/test/simulate_payment` and `/test/simulate_sweep` when `include_simulated` is true), so
a plugin's bookkeeping can be built against the sandbox; live exports never contain simulated rows.

## Retention

Records are kept for ten years after the end of the fiscal year they belong to, including after an account is
closed. Export files are kept seven days. Details and the reasoning: `docs/10-records-and-tax.md` §8.5.
