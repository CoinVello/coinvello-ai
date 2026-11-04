# Testing

## Test mode

Use a `cv_test_` key. Test mode is a complete, isolated copy of the API:

* Wallets, invoices, webhooks, credits and events are separate from live.
* Test credits cost nothing: every 24 hours the test balance is set back to 200 available credits
  (`test_credits_daily` and `test_credits_reset_at` on `GET /credits`). Unused ones do not carry over; when
  they run out, new test invoices paid with credits get `402 insufficient_credits` with `details.resets_at`
  until the reset. Live accounts start with no credits: they buy credits or use pay as you go.
* Wallet verification is optional here as in live mode.
* Addresses are derived on **test networks**:

| Chain | Test network | Faucet / explorer |
|-------|--------------|-------------------|
| bitcoin | signet (default) or testnet4 | mempool.space/signet, signetfaucet.com |
| ethereum | sepolia | sepolia.etherscan.io |
| base | base-sepolia | sepolia.basescan.org |
| arbitrum | arbitrum-sepolia | sepolia.arbiscan.io |
| optimism | optimism-sepolia | sepolia-optimism.etherscan.io |
| polygon | amoy | amoy.polygonscan.com |
| bnb | bnb-testnet | testnet.bscscan.com |
| avalanche | fuji | testnet.snowtrace.io |
| robinhood | robinhood-testnet (chain id 46630) | explorer.testnet.chain.robinhood.com, faucet.testnet.chain.robinhood.com (`usdg:robinhood` uses the public faucet MockUSDG `0x8F92...23BC`) |
| solana | devnet | explorer.solana.com/?cluster=devnet |
| tron | nile | nile.tronscan.org |

Test-mode tokens (USDC, USDT, EURC, PYUSD, USDG) use pinned testnet contracts; `GET /assets` with a test
key (or `CoinVello-Livemode: false`) returns their addresses and a faucet URL in `faucet_url`.

Some tokens have no official testnet contract, so they are **live-only**: test mode does not list, offer or
accept them (a test wallet or invoice that names one is refused with `422`). They are `usdt:base`, `usdt:arbitrum`
(USD₮0), `usdt:optimism`, `usdt:avalanche`, `usdt:solana`, `usdc:bnb` (Binance-Peg USDC, 18 decimals) and
DAI (`dai:ethereum`, `dai:base`, `dai:arbitrum`, `dai:optimism`, `dai:polygon`), and every Bitcoin token: WBTC
(`wbtc:ethereum`, `wbtc:base`, `wbtc:arbitrum`, `wbtc:optimism`, `wbtc:polygon`), cbBTC (`cbbtc:ethereum`,
`cbbtc:base`, `cbbtc:arbitrum`, `cbbtc:solana`), `btcb:bnb` (BTCB, 18 decimals) and `btcb:avalanche` (BTC.b).
Test the same flow with another token on that chain (for example `usdc:base`, or `btc:bitcoin` on testnet for
a Bitcoin price), then switch to live.

You can pay test invoices with real testnet coins and watch the real detection pipeline
work, or skip the faucet entirely with the simulate endpoint.

Smart-account payments are detected too: when a MetaMask smart account (EIP-7702), an ERC-4337
bundler, a Safe or an exchange hot-wallet contract pays, the native-coin transfer to your address
is an *internal* call rather than a top-level transaction. CoinVello watches balance changes per
block and attributes them through transaction traces (or Alchemy's transfer index), so the payment
is recorded against the real transaction hash. ERC-20 and TRC-20 payments are attributed by the
transfer event's recipient, never by the transaction's target, so routers, bundlers and Safes work.
Native TRX sent by a Tron smart-contract wallet is picked up from the transaction's internal
transactions.

Every chain applies a two-source rule before a payment is reported as confirmed: an independent
second node (QuickNode on EVM chains and Bitcoin, a second Tron HTTP node for Tron, the public
Esplora API when Bitcoin runs on CoinVello's own node) must agree on the transaction's block and
success. When the two disagree the payment is held; when no second source is available the first
source alone must show twice the usual confirmations. In test mode this is why a testnet payment
can take longer than the `required_confirmations` shown.

## `POST /test/simulate_payment`

Creates a synthetic payment and runs it through the **real** state machine and webhook
pipeline. Test keys only (`403 test_mode_only` otherwise).

```bash
curl https://api.coinvello.com/v1/test/simulate_payment \
  -H "Authorization: Bearer cv_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "invoice_id": "inv_9XyZ12AbC3",
    "asset": "btc:bitcoin",
    "confirmations": 0
  }'
```

| Field | Default | Effect |
|-------|---------|--------|
| `invoice_id` | required | Invoice (`inv_`) or credit purchase (`cpu_`) to pay |
| `asset` | first accepted | Which payment option to pay |
| `amount` | exact `payment_options[].amount` | Lower -> `underpaid`; higher -> `overpaid` (beyond tolerance) |
| `confirmations` | 0 | `0` -> payment `detected`, invoice `pending`/`confirming`; `>= required` -> `paid` |
| `tx_hash` | random | Reuse to advance the **same** payment instead of adding a second one |
| `from_address` | random | Reported as the sender |
| `delay_seconds` | 0 | Delay processing (test polling UIs) |

Response: `{ "payment": {...}, "invoice": {...} }`.

### Scenarios

```bash
# Happy path in one call
-d '{"invoice_id":"inv_...","asset":"usdt:tron","confirmations":19}'

# Step through: detected -> confirming -> paid
-d '{"invoice_id":"inv_...","asset":"btc:bitcoin","confirmations":0,"tx_hash":"aa11"}'
-d '{"invoice_id":"inv_...","asset":"btc:bitcoin","confirmations":1,"tx_hash":"aa11"}'

# Underpaid by 10 %
-d '{"invoice_id":"inv_...","asset":"usdc:polygon","amount":"45.00","confirmations":64}'

# Two partial payments that add up
-d '{"invoice_id":"inv_...","asset":"btc:bitcoin","amount":"0.0004","confirmations":1,"tx_hash":"p1"}'
-d '{"invoice_id":"inv_...","asset":"btc:bitcoin","amount":"0.0003423","confirmations":1,"tx_hash":"p2"}'

# Late payment after expiry (invoice stays expired, payment recorded, refund_claim_url set)
curl -X POST .../invoices/inv_.../expire ...
-d '{"invoice_id":"inv_...","asset":"btc:bitcoin","confirmations":1}'
```

Simulated payments have `"simulated": true`.

## Test webhooks

* `POST /webhooks/{id}/test` sends a signed `ping` or any event type with sample data.
* Test endpoints may be plain `http://` and may point at `localhost` when you run the
  [reference server](../reference-server/README.md) locally.
* Signatures use the same scheme as live, so your verifier is exercised for real.

## Reference mock server

`api/reference-server` is a small Express app that implements invoice create/get/list,
checkout sessions, credit purchases, webhook endpoints with real HMAC signing, and
`/test/simulate_payment`. Plugins and SDKs can run their CI against it without network
access or a CoinVello account:

```bash
cd api/reference-server
npm install
npm run dev            # http://localhost:4242/v1, accepts any key starting with cv_test_
```

Set your plugin's API base URL to `http://localhost:4242/v1`.

## Test cards / fiat

There are none: CoinVello processes crypto only. Credit purchases in test mode are simulated
the same way (`/test/simulate_payment` with a `cpu_` id).

## Checklist before going live

- [ ] Fulfilment is driven by `invoice.paid` webhooks, not by the success redirect
- [ ] Webhook handler verifies `CoinVello-Signature`, checks the 5-minute window and dedupes on `event.id`
- [ ] `invoice.underpaid`, `invoice.overpaid` and `invoice.expired` are surfaced to staff
- [ ] Idempotency keys are sent on invoice/checkout creation and retried on network errors
- [ ] Each accepted asset has an enabled live wallet; for xpubs, `first_address` matches your wallet's first receive address
- [ ] Credits balance monitored (`credits.low` webhook or dashboard alert)
- [ ] API keys live in server-side secrets, not in the storefront bundle
