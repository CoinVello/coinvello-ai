# Authentication

All requests are authenticated with a secret API key in the `Authorization` header:

```
Authorization: Bearer cv_live_51HqZ9kL2mN3oP4qR5sT6uV7wX8yZ9aB0cD1eF2gH3iJ4kL5mN6oP7qR8sT9uV0w
```

Requests without a valid key return `401 authentication_error`. All requests must use
HTTPS; plain HTTP is refused at the edge.

## Key types

| Prefix | Mode | Who | Notes |
|--------|------|-----|-------|
| `cv_test_` | Test | Merchant | Testnets, free test credits, `/test/*` helpers |
| `cv_live_` | Live | Merchant | Mainnets, real credits |
| `cv_test_rk_` / `cv_live_rk_` | Test / Live | Merchant (restricted) | Scoped to specific resources/actions |
| `cv_admin_` | - | CoinVello staff only | `/admin/*` surface, never issued to merchants |

Create and revoke keys in **Dashboard -> Settings -> API keys** (backed by the session-only
`/api-keys` endpoints, which require a 2FA step-up). Keys created from 2026-10-29 on can be viewed and copied there again; older keys were stored as a hash only.
Up to 20 active keys per mode. Signing up (`POST /auth/signup`) issues the first test key.

Creating an account and getting keys requires only an email address. There is no KYC/KYB
step; see [getting-started.md](getting-started.md#no-kyc-no-kyb).

## Restricted keys and scopes

Restricted keys let you give a plugin or server exactly the permissions it needs. Scopes are
`<resource>:<read|write>`:

```
invoices:read invoices:write payments:read wallets:read wallets:write
webhooks:read webhooks:write credits:read credits:write rates:read
conversions:read conversions:write offramp:read offramp:write
checkout_sessions:write refunds:read refunds:write events:read receivers:read receivers:write
records:read exports:read exports:write
```

A WooCommerce plugin, for example, needs `invoices:write invoices:read payments:read
checkout_sessions:write webhooks:write events:read`. A call outside the key's scope returns
`403 permission_error` with code `insufficient_scope`.

## Publishable keys

There are **no** publishable keys. Anything that runs in a browser should talk to your server,
which talks to CoinVello - or use a [Checkout Session](checkout.md) URL, which is safe to hand
to the customer because it cannot be used to read or create anything else.

## Test vs. live isolation

Objects are partitioned by mode. A test key cannot see live invoices and a live key cannot see
test invoices; cross-mode ids return `404 resource_missing`. Every object carries a `livemode`
boolean so you can sanity-check at runtime.

## Rotating a key

1. Create a new key in the dashboard.
2. Deploy it.
3. Revoke the old key. Revocation is immediate; in-flight requests complete.

If a key leaks, revoke it first and investigate later. Webhook secrets are rotated separately
(`POST /webhooks/{id}/rotate_secret`, see [webhooks.md](webhooks.md)).

## Admin authentication (staff only)

The `/admin/*` endpoints use a separate scheme: a staff dashboard session cookie
(`cv_admin_session`) issued only after a completed 2FA challenge, or an admin API key
(`cv_admin_...`) that is IP-allowlisted and scoped. Mutating admin calls require a
`CoinVello-Admin-Reason` header, which is written to the audit log. Merchant keys get
`403 admin_only` on `/admin`, and admin keys get `403` on merchant endpoints. Details in
[admin.md](admin.md).

## Dashboard passwords

API keys do not have passwords. The password belongs to the dashboard account that manages the
keys; if it is forgotten, `POST /auth/password/forgot` (staff: `POST /admin/auth/password/forgot`)
emails a single-use link and `POST /auth/password/reset` sets a new one. A reset signs out every
dashboard session but leaves API keys and 2FA untouched. Details in
[security.md](security.md#password-reset).

## Request headers summary

| Header | Required | Purpose |
|--------|----------|---------|
| `Authorization: Bearer <key>` | yes | Authentication |
| `Content-Type: application/json` | on POST/PATCH/PUT | Body encoding |
| `Idempotency-Key` | recommended on POST | Safe retries ([idempotency.md](idempotency.md)) |
| `CoinVello-Version` | optional | Pin an API version ([versioning.md](versioning.md)) |
| `User-Agent` | recommended | e.g. `coinvello-woocommerce/1.2.0 (php 8.3)` - helps support |

## Response headers summary

| Header | Purpose |
|--------|---------|
| `Request-Id` | Quote this when contacting support |
| `Idempotency-Replayed` | `true` when a stored response was returned |
| `CoinVello-Version` | Version the response was rendered with |
| `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After` | [rate-limits.md](rate-limits.md) |
