# Admin API (CoinVello staff only)

The `/admin/*` surface is **internal**. It is documented here because it lives in the same
OpenAPI file and shares schemas, but it is never exposed to merchants, SDKs do not wrap it,
and merchant keys are rejected with `403 admin_only`.

## Authentication

Two mechanisms, both separate from merchant keys:

| Mechanism | How | Notes |
|-----------|-----|-------|
| Staff dashboard session | Cookie `cv_admin_session` | Issued only after password **and** a 2FA challenge (TOTP or WebAuthn). 12-hour lifetime, re-prompt for 2FA (step-up) on sensitive actions. Mutations need `X-CSRF-Token`. |
| Admin API key | `Authorization: Bearer cv_admin_...` | Issued per staff member, IP-allowlisted, scoped (`operator_wallets:write`, `merchants:read`, ...), 90-day expiry. For automation and the admin panel backend; sensitive writes also need `CoinVello-MFA-Code` (a current TOTP code for that staff member). |

Every mutating call must carry `CoinVello-Admin-Reason: <free text>`. All admin calls - reads
included - are written to an append-only audit log with staff id, IP, reason and diff.

## Resources

### Operator wallets - `/admin/operator-wallets`

Where merchants' credit purchases are received. CRUD with soft-delete.

```json
{
  "chain": "bitcoin",
  "assets": ["btc:bitcoin"],
  "xpub": "zpub6s1fB2d...",
  "derivation_path": "m/84'/0'/0'",
  "address_type": "p2wpkh",
  "label": "Ops cold BTC #1",
  "enabled": true,
  "priority": 10
}
```

* BTC: `xpub` + `derivation_path` (+ `address_type`); a fresh address is derived per purchase.
* EVM/Solana/Tron: `address`; reused with amount tagging, like merchant address wallets.
* One EVM address on several chains: pass `chains: [...]` instead of `chain`; one wallet per chain
  is created as a group (`group_id`, listed together with `?group_id=`), and the activation delay
  applies to all of them at once. An existing address
  wallet is extended with `POST /admin/operator-wallets/{id}/chains {"chains": [...]}` (step-up
  required): siblings join its group as `active` (with the delay), and `GET /admin/operator-wallets/{id}`
  returns `group_chains` so the panel can show what is already covered.
* No asset filter: an operator wallet accepts every asset on its chain (native coin and every token
  available in its mode); `assets` in create/update requests is ignored.
* `priority` (lower wins) selects between several enabled wallets for the same asset -
  use it to drain one wallet while warming up another.
* **2FA step-up and activation delay, no separate approval.** Only `owner` or `finance` staff can add
  a wallet, with a fresh second factor (a session step-up in the last 5 minutes, or
  `CoinVello-MFA-Code: <TOTP>` on an admin-key call). That step-up is the approval: the wallet is
  created `active` with `active_from` one hour later (`OPERATOR_WALLET_ACTIVATION_DELAY_SECONDS`, 0 allowed)
  and receives no purchases before that; the delay is the safety net against a hijacked staff account.
  Creation is audit-logged. `POST /admin/operator-wallets/{id}/approve` remains for wallets created
  `pending_approval` before this change.
* Key material is immutable; to rotate, add a new wallet, then disable the old one.
  Disabled/retired wallets keep being monitored for open purchases.
* Validation is identical to merchant wallets (`xprv_rejected`, `xpub_invalid`, `address_invalid`).

Only assets that have at least one enabled operator wallet appear in `GET /credits/bundles`
`crypto_prices` and in purchase `payment_options`.

### Credit bundles - `/admin/credit-bundles`

```json
{ "id": "bnd_growth_15000", "name": "Growth", "credits": 15000, "bonus_credits": 0, "price_usd": "120.00", "enabled": true, "sort_order": 2 }
```

Canonical seed (docs/03-fees-and-credits.md): `bnd_starter_2500` ($25),
`bnd_growth_15000` ($120), `bnd_scale_75000` ($450), `bnd_volume_400000` ($1,600), `bnd_enterprise`
(2,000,000+, negotiated, <= $0.003/credit). Stablecoin discount (300 bps) and the 24-month expiry are
global settings, not per bundle. There is no free bundle and no overage limit: the credit balance never
goes below zero, and accounts that do not want to prepay use pay as you go.

```json
{ "stablecoin_discount_bps": 300, "credit_expiry_months": 24 }
```

Bundles are never hard-deleted (ledger entries reference them); `DELETE` sets `enabled: false`.
Price changes apply to new purchases only - an open purchase keeps its locked price.

### Merchants - `/admin/merchants`

List/search (`?query=`, `?email=`, `?status=`) and get. Returns account status, credit
balance and activity counts. There is **no identity data** here because CoinVello collects
none: a merchant record is an email, a business name they typed, keys, wallets and counters.

`POST /admin/merchants/{id}/suspend { "suspended": true, "reason": "abuse", "note": "..." }`
blocks new invoices, checkout sessions and credit purchases. Existing invoices continue to be
monitored and webhooks continue to fire, so paying customers are never left hanging. Pass
`"suspended": false` to lift.

### Credit ledger - `/admin/credit-ledger`

Global view of every merchant's ledger with `merchant_id`, filterable by merchant, type and
reason. `POST` creates a manual adjustment (`credit` or `debit`) with a reason of
`adjustment`, `promo`, `bonus` or `refund_of_fee`. Idempotency-Key is honoured.

### Purchases - `/admin/purchases`

All credit purchases across merchants, filterable by `merchant_id`, `status` and
`operator_wallet_id`. Each row adds `merchant_id` and `operator_wallet_id` to the
merchant-facing `CreditPurchase` shape. Use it to reconcile operator wallet inflows against
credited balances.

### Audit log - `/admin/audit-log`

Every admin write and approval, newest first, with staff id, action (`operator_wallet.create`,
`operator_wallet.approve`, `credit_bundle.update`, `merchant.suspend`, `credit_ledger.adjust`, ...),
the `CoinVello-Admin-Reason` text, IP and a before/after diff. Filter by `staff_id` or `action`
(prefix wildcards such as `operator_wallet.*`).

## Operational notes

* Admin endpoints are served from the same host but routed to a separate service with its
  own rate limit (20 r/s per key) and no access to merchant xpub material beyond what the
  merchant API itself exposes (redacted).
* The admin panel UI (website/ repo) is a thin client over these endpoints and uses the
  session mechanism; CI tooling uses `cv_admin_` keys.
* Brand for the panel: navy `#0B3B5C`, deep sky `#0B5C96` accent (sky `#7CC4FF` on dark), ink `#0E1726` on paper `#F7F8FA`;
  fonts Sora (headings), Inter (body), JetBrains Mono (ids, hashes, amounts). See `brand/tokens.css`.
