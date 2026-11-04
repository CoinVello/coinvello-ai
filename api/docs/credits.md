# Credits

CoinVello charges fees as **prepaid processing credits**, not as a percentage skimmed from
your payments - it couldn't skim even if it wanted to, since funds go straight to your
wallet. You buy credits in bundles (paid in crypto to CoinVello's own operator wallets, or by
card), and each confirmed payment consumes a small number of credits proportional to its
fiat value. There are no free credits: if you would rather not prepay, use
[pay as you go](#pay-as-you-go). The canonical pricing model is
`docs/03-fees-and-credits.md` in the repository root; this page describes how it surfaces in the API.

## Units and the consumption rule

**1 credit = $0.01 of nominal processing value.** Credits are integers.

Every payment that reaches `paid`, `overpaid` or `underpaid` (accepted) consumes:

```
credits = clamp( round( fiat_value_usd × 0.0030 / 0.01 ),  # 30 bps nominal
                 min = 2,                                   # floor: $0.02 nominal
                 max = 2000 )                               # cap:   $20 nominal
```

`fiat_value_usd` is the amount actually received, valued at the invoice's **locked rate** and
converted to USD - never the crypto amount, so volatility does not change your fee.

| Payment | Credits | Nominal |
|---------|---------|---------|
| $2.00 | 2 (floor) | $0.02 |
| $49.99 | 15 | $0.15 |
| $80 | 24 | $0.24 |
| $500 | 150 | $1.50 |
| $20,000 and up | 2,000 (cap) | $20 |

Nothing is consumed for `expired`, `cancelled`, rejected-underpaid or **test-mode** invoices.
Checkout sessions cost exactly the same as a bare invoice (hosting is free). Rate locks,
quotes, webhooks, events, refunds, dashboard, plugins and exports are included.

### Optional add-ons (only when you turn them on)

| Add-on | Credits | Charged when |
|--------|---------|--------------|
| Conversion (swap orchestration) | +10 bps nominal of the swapped amount, cap 1,000 per swap | When the conversion is created from a quote (refunded on `failed`/`expired`/`cancelled`) |
| Off-ramp orchestration | flat 20 per payout job | When the payout is created (refunded if cancelled/expired before deposit) |
| Address risk screening | +1 per screened payment | With the payment's own fee |

Partner, DEX and network fees are separate and paid on-chain by you; CoinVello adds no spread.

## What the dollars look like

| Bundle | id | Credits | Price | $/credit | Effective rate |
|--------|----|---------|-------|----------|----------------|
| Starter | `bnd_starter_2500` | 2,500 | $25 | $0.0100 | **0.30%** |
| Growth | `bnd_growth_15000` | 15,000 | $120 | $0.0080 | **0.24%** |
| Scale | `bnd_scale_75000` | 75,000 | $450 | $0.0060 | **0.18%** |
| Volume | `bnd_volume_400000` | 400,000 | $1,600 | $0.0040 | **0.12%** |
| Enterprise | `bnd_enterprise` | 2,000,000+ | from $6,000 (≤ $0.0030) | ≤ $0.0030 | **≤ 0.09%** |

Rules:

* **Purchased credits expire 24 months** after purchase (`expiry` ledger entries). The balance
  response shows what expires soon.
* **3% discount** on the bundle price when you pay in a stablecoin (USDC, USDT, DAI).
  Volatile assets (BTC, ETH, SOL...) and card pay list price.
* **Tier lock:** top-ups within 12 months of a larger bundle are sold at that bundle's $/credit.
* Bundles are configured by CoinVello staff (`/admin/credit-bundles`); `GET /credits/bundles`
  shows the enabled ones with current `crypto_prices`.

## Running out of credits

The balance **never goes below zero**: CoinVello does not extend credit, so there is no
deficit, no overage and nothing billed later. Because funds go to your wallet regardless of
what CoinVello does, billing never blocks a payment in progress:

1. **Reservation.** Creating an invoice (or checkout session) whose fee is paid in credits
   reserves its estimated fee, `clamp(round(usd x 30 bps / $0.01), 2, 2000)`, until the invoice
   is paid (the actual fee is charged instead), expires or is cancelled.
2. **Low balance.** `available` below `low_balance_threshold` (default 200): `credits.low`
   webhook, email, banner; [auto top-up](#auto-top-up) buys a bundle if you turned it on.
3. **Payments bigger than the invoice** are charged at most what the account holds, so an
   overpayment never takes the balance below zero.
4. **Auto switch to pay as you go** (`account.auto_switch_to_pay_as_you_go`, **on by default**).
   When a prepaid account's credits cannot cover a new invoice, or run out after a fee, the
   account switches to `billing_plan: "pay_as_you_go"` instead of refusing invoices, and a notice
   is emailed to the account email. Switch back to prepaid with `PATCH /account` at any time.
   Bitcoin payments still use credits, so those can still be refused when credits run out.
5. **Refusal.** With auto switch off (`PATCH /account` with
   `{ "auto_switch_to_pay_as_you_go": false }`) and no automatic top-up to refill, `POST /invoices`
   and `POST /checkout-sessions` paid with credits return `402 credits_error / insufficient_credits`
   with `details: { available, required, bundles_url }`. Detection and webhooks for
   already-issued invoices continue: their fees were reserved when they were created.

Test mode gets 200 free credits every 24 hours (`test_credits_daily`, `test_credits_reset_at` on `GET /credits`).
Unused test credits do not carry over, and a test invoice that needs more than is left gets
`402 insufficient_credits` with `details.resets_at`.

## Balance

```bash
curl https://api.coinvello.com/v1/credits/balance -H "Authorization: Bearer cv_live_..."
```

```json
{
  "object": "credits_balance",
  "livemode": true,
  "balance": 11840,
  "available": 11795,
  "reserved": 45,
  "expiring_soon": { "credits": 0, "before": "2026-11-21T00:00:00Z" },
  "low_balance_threshold": 200,
  "estimated_payments_remaining": 493,
  "auto_topup": { "enabled": false }
}
```

`balance` is what the account holds (never negative); `reserved` is the estimated fees of open
invoices paid with credits; `available` = `balance` - `reserved` is what a new invoice can
reserve. `estimated_payments_remaining` divides `available` by your trailing-30-day average
credits per payment.

## Bundles

```bash
curl https://api.coinvello.com/v1/credits/bundles
```

```json
{
  "id": "bnd_growth_15000",
  "object": "credit_bundle",
  "name": "Growth",
  "credits": 15000,
  "bonus_credits": 0,
  "price": { "amount": "120.00", "currency": "USD" },
  "price_per_credit": "0.0080",
  "effective_rate_bps": 24,
  "stablecoin_discount_bps": 300,
  "expires_after_months": 24,
  "crypto_prices": [
    { "asset": "btc:bitcoin", "amount": "0.00178173", "rate": "67350.12" },
    { "asset": "usdc:base", "amount": "116.411641", "rate": "0.9999", "discount_applied": true }
  ]
}
```

`crypto_prices` already reflects the stablecoin discount where it applies; the real amount is
locked when the purchase is created.

## Buying credits

```bash
curl https://api.coinvello.com/v1/credits/purchases \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: topup-2026-10-21-1" \
  -d '{ "bundle_id": "bnd_growth_15000", "pay_asset": "usdc", "pay_chain": "base" }'
```

The response is a **CreditPurchase**. Its `payment` object is shaped exactly like an invoice:

```json
{
  "id": "cpu_6Rt8Yu3Kp",
  "object": "credit_purchase",
  "status": "new",
  "bundle_id": "bnd_growth_15000",
  "credits": 15000,
  "price": { "amount": "116.40", "currency": "USD" },
  "list_price": { "amount": "120.00", "currency": "USD" },
  "discount": { "type": "stablecoin", "bps": 300 },
  "payment": {
    "status": "new",
    "amount": "116.40",
    "currency": "USD",
    "payment_options": [
      {
        "asset": "usdc:base",
        "chain": "base",
        "address": "0xOpsWallet...",
        "amount": "116.411641",
        "payment_uri": "ethereum:0x036C...@8453/transfer?address=0xOpsWallet...&uint256=116411641",
        "qr_payload": "ethereum:0x036C...@8453/transfer?address=0xOpsWallet...&uint256=116411641",
        "required_confirmations": 12
      }
    ],
    "rate_locked_until": "2026-10-21T10:15:00Z",
    "expires_at": "2026-10-21T10:15:00Z"
  },
  "checkout_url": "https://pay.coinvello.com/credits/cpu_6Rt8Yu3Kp"
}
```

Omit `pay_asset`/`pay_chain` to get one payment option per network CoinVello accepts, or
just open `checkout_url` in a browser, which renders the same options with QR codes and
wallet buttons. The rate is locked for 15 minutes.

**This is the one place CoinVello receives funds**: the receiving addresses belong to
CoinVello's operator wallets, as payment for the service. Everything else in the API pays
*you*.

### Paying by card

Credits can also be bought with a saved card. Cards are processed by **Square**: the dashboard
shows Square's card fields (Square's Web Payments SDK), Square tokenizes the card in the browser,
and CoinVello stores only the brand, last four digits and expiry. Saving a card is a dashboard
action behind a fresh 2FA code; API keys cannot add cards. Up to 3 cards per mode.

```bash
curl https://api.coinvello.com/v1/credits/payment_methods -H "Authorization: Bearer cv_live_..."
# -> { "data": [ { "id": "pm_7Qa2Kd9LmPx4Rt", "brand": "Visa", "last4": "4242", "exp": "12/29", "is_default": true } ], ... }

curl https://api.coinvello.com/v1/credits/purchases \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: topup-2026-10-22-1" \
  -d '{ "bundle_id": "bnd_growth_15000", "payment_method": "pm_7Qa2Kd9LmPx4Rt" }'
```

In the dashboard checkout a merchant can also type a card for one payment (`source_id`, the Square
token) and optionally keep it (`save_card`, which asks for 2FA); API keys always pay with a saved card.

The card is charged at once and the response is final: `status: "paid"` with the credits already
added, `payment: null` and a `card` object (`brand`, `last4`, `auto_topup`). A decline returns
`402 card_declined` (type `card_error`, `details.purchase_id` names the `failed` purchase). Rarely
Square holds a charge; the purchase is then `pending` and settles by itself within minutes.

| Rule | Value |
|------|-------|
| Price | List price (the 3% stablecoin discount is crypto-only) |
| Daily limit | $2,000 per 24 h, $500 while the account is younger than 14 days (`422 card_limit_exceeded`) |
| Declines | After 3 declines in 24 h card purchases pause for 24 h (`422 card_locked`) |
| Refund or chargeback | The purchase becomes `refunded` or `disputed` and its credits are reversed (`purchase_reversal`; the balance stops at zero, it never goes negative). A chargeback also removes the account's saved cards and switches auto top-up off. |

In test mode card payments run against Square's sandbox and nothing is ever charged. For automated
tests, `POST /test/payment_methods` saves Square's sandbox test card without the browser form.

### Lifecycle

Crypto purchases follow invoices: `new -> pending -> confirming -> paid | underpaid | overpaid | expired | cancelled`.
Card purchases are `paid`, `pending` (held by Square), `failed` (declined), `refunded` or `disputed`.

| Event | Meaning |
|-------|---------|
| `credits.purchase.paid` | Confirmed. Credits are added immediately (`credits.added` follows). |
| `credits.purchase.underpaid` | Confirmed below the price. Credits are granted **pro-rata** at the locked rate; the dashboard offers to top up the remainder to the same address within 24 h. |
| `credits.purchase.expired` | Nothing arrived before `payment.expires_at`. A late payment is still detected (addresses stay watched 7 days) and credited at the rate current at detection. |
| `credits.purchase.failed` | A card purchase was declined (also for automatic top-up). |
| `credits.purchase.refunded` | A card purchase was refunded or charged back; its credits were reversed. |
| `credits.added` | Credits landed in the balance from any source (`data.object` is the ledger entry, `data.balance` the new balance). |

Overpayments are credited as additional credits at the same $/credit - CoinVello never holds
unapplied funds. A reorg that drops a confirmed purchase posts a `reorg_reversal` entry and
re-credits if the payment re-confirms.

`GET /credits/purchases` and `GET /credits/purchases/{id}` for history;
`POST /credits/purchases/{id}/cancel` while unpaid. In test mode, pay a purchase with
`POST /test/simulate_payment { "invoice_id": "cpu_..." }`.

## Ledger

```bash
curl "https://api.coinvello.com/v1/credits/ledger?limit=50&reason=invoice_fee" \
  -H "Authorization: Bearer cv_live_..."
```

Every debit and credit, newest first, with `balance_after` and the related object:

```json
{
  "id": "led_9Ks2Lm4Np",
  "type": "debit",
  "reason": "invoice_fee",
  "amount": 15,
  "balance_after": 11825,
  "related_object": { "id": "inv_9XyZ12AbC3", "object": "invoice" },
  "description": "Invoice WC-10042: $49.99 x 30 bps",
  "created_at": "2026-10-21T10:04:12Z"
}
```

Reasons: `invoice_fee`, `checkout_fee`, `conversion_fee`, `offramp_fee`, `screening_fee`,
`purchase`, `purchase_reversal`, `bonus`, `promo`, `adjustment`, `refund_of_fee`, `reorg_reversal`,
`expiry`. `overage_surcharge` and `free_monthly_grant` remain in the enum for old entries only (the
overage policy and the free monthly grant were retired). Each paid invoice also carries
`fee: { plan, credits, bps, fiat_value_usd }` so you can see the charge without opening the ledger.

## Auto top-up

`PUT /credits/auto_topup` buys a bundle with a saved card whenever the balance falls below a
threshold. Crypto cannot be pulled from a wallet, so automatic top-up is card-only and needs a
saved card (`422 payment_method_required`).

```bash
curl -X PUT https://api.coinvello.com/v1/credits/auto_topup \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{ "enabled": true, "bundle_id": "bnd_growth_15000", "trigger_below": 2000, "monthly_limit": "500.00" }'
```

- `payment_method` picks a card (default: the default card); `monthly_limit` caps automatic
  charges per calendar month (UTC); the daily card limit applies too.
- At most one automatic charge every 10 minutes.
- After 3 declines in a row it switches itself off with `disabled_reason: "card_declined"` and
  fires `credits.auto_topup.disabled`. Removing its card (`payment_method_removed`) or a chargeback
  (`disputed`) does the same.
- The balance's `auto_topup` object reports `spent_this_month`, `consecutive_failures`,
  `last_attempt_at` and `disabled_reason`.

## Pay as you go

Instead of prepaying, an account can set `billing_plan: "pay_as_you_go"` (`PATCH /account`; with a dashboard
session it needs a 2FA step-up). CoinVello then takes **0.4% of each payment on-chain** (`fee_bps: 40`), with
nothing to buy up front. Prepaid credits stay the cheaper option (0.30% down to under 0.10%). A prepaid account
also moves here automatically when its credits run out, unless `auto_switch_to_pay_as_you_go` is false (see
[Running out of credits](#running-out-of-credits)).

How it works, without CoinVello ever holding your money:

- For every wallet on a supported chain CoinVello creates a **receiver** (`GET /receivers`): a contract (EVM,
  Tron) or program vault (Solana) that belongs to your wallet address. Invoices created afterwards point their
  payment options at it (`payment_options[].receiver_id`). Customers pay it with ordinary transfers.
- A **sweep** pays the receiver's balance out: 99.6% to your wallet, 0.4% to CoinVello's fee address, in one
  transaction. Nobody can change those numbers or send the money anywhere else, CoinVello included. If
  CoinVello's fee address cannot take a payment (for example an issuer froze it), the fee goes to a backup
  address, and if that fails too you are paid in full.
- CoinVello's sweeper triggers sweeps when the fee covers the network fee several times over, so busy receivers
  are swept often and quiet ones less often (`receiver.next_sweep`). You can sweep any time yourself:
  `POST /receivers/{id}/sweep_transaction` returns an unsigned transaction to sign with any wallet (you pay its
  network fee). Every sweep, whoever triggered it, appears in `GET /sweeps` and fires `sweep.confirmed`.
- Each paid invoice shows its fee as `fee: { plan: "pay_as_you_go", bps: 40, amount, asset, receiver_id,
  sweep_id }`; `sweep_id` is set once the sweep that collected it confirms.

Supported chains: Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche and Robinhood Chain, then
Solana and Tron (`account.pay_as_you_go.chains[].status`). Bitcoin has no contracts, so on that
chain the account keeps using credits. There is no billing in arrears.

### Contracts and safety

Prepaid credits never involve a contract: payments go straight to your own wallet. The contracts below exist
only for pay as you go.

- **Your receiver.** A contract (EVM, Tron) or a program-owned vault PDA (Solana) whose address commits to the
  factory, your payout wallet, `feeRecipient`, `feeRecipientBackup` and `feeBps`. On EVM and Tron, payments can
  arrive before the contract exists (counterfactual CREATE2 address); it is deployed with its first sweep
  (`factory.deployAndSweep`). Solana vaults need no deployment.
- **Permissionless sweeps.** `sweep(token)`, `sweepNative()` and `sweepAll` (Solana: `sweep_sol`, `sweep_token`)
  can be called by anyone. They send `floor(balance x 40 / 10000)` to CoinVello's fee address and the rest
  (99.6%) to you, in one transaction. If the fee address cannot take the asset the fee goes to the backup
  (`FeePaidToBackup`), and if that fails too you get everything (`FeeForfeited`). Your leg has no fallback: if
  it cannot be paid, the sweep reverts and the funds stay in the receiver.
- **Nothing can be changed.** `payout`, `feeRecipient`, `feeRecipientBackup` and `feeBps` are immutable. There
  is no owner, admin, pause, upgrade, setter, `selfdestruct` or `delegatecall`. Solidity 0.8.24 with
  OpenZeppelin 5.6.1 (SafeERC20, Math.mulDiv, ReentrancyGuard).

| Mainnet deployment | Address |
|--------------------|---------|
| EVM `CoinVelloReceiverFactory` on Ethereum (1), Base (8453), Arbitrum One (42161), OP Mainnet (10), Polygon (137), BNB Smart Chain (56), Avalanche C-Chain (43114); same address everywhere through the deterministic CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` | `0x4acA19Abe7a184a81c992dcA3c0432b892C98da7` |
| Tron factory | `TUGyMNRrd6DP5YLMy1P9HVqrJ9pFe4Ta2J` |
| Solana program (upgrade authority: none, so immutable; program data sha256 `cd804af1e031b1141e608762b21233052a719785d14cd4ab9b77479db3852616`, verifiable build) | `2ZxRKdxZxQ1FqKYhjdCd2iZTGznaNTx1ZuAfMF7ZysMr` |

| Fee address (multisig) | Primary | Backup |
|------------------------|---------|--------|
| EVM (Safe) | `0x02FDb629Dc017D3f115D82704cE34aD8b15773aC` | `0x9178411cDa785999a512f60434fdDaA3E054aa15` |
| Tron (multisig account) | `TVxwn29oqnwL8ar7Ramh5htLDSnoeK2udt` | `TDzHd4THdZ6RU2BVq7z4mK4RGPMg7nntgt` |
| Solana (Squads) | `CHTNf9xF8fLj7YSAFvwyyuXw43gE4Nfg6Qa2sWCDpAvA` | `DWJ6THXUEXmrYBFb8Tx8ZHqddwcwdHgpcEZ1TFkjw4Ac` |

`GET /receivers` returns each receiver's `address`, `contract.address` (factory or program), `fee_recipient`,
`fee_recipient_backup` and `fee_bps`, so you can check them against these tables.

**Audit status.** The contracts and the program are not yet externally audited. Sources: `contracts/` and `solana/` in the repository.

In test mode `POST /test/simulate_sweep` records a sweep of a test receiver and fires the same events, so you
can build the accounting before going live. Model and safeguards: `docs/03-fees-and-credits.md` §3d.
