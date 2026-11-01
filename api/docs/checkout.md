# Hosted checkout

A **Checkout Session** creates an invoice *and* a hosted payment page on
`pay.coinvello.com`. You redirect the customer there, CoinVello handles asset selection,
QR codes, wallet buttons, countdown, status updates and the return redirect. It is the
fastest integration path and the one the e-commerce plugins use by default.

```
POST /checkout-sessions  ->  { "url": "https://pay.coinvello.com/c/cs_...", "invoice_id": "inv_..." }
   redirect customer to url
   customer pays; page polls/pushes status; redirects to success_url on `redirect_on`
   your server receives invoice.paid webhook  ->  fulfil
```

## Create

```bash
curl https://api.coinvello.com/v1/checkout-sessions \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-8812-checkout" \
  -d '{
    "amount": "129.00",
    "currency": "EUR",
    "accepted_assets": ["btc:bitcoin", "eth:ethereum", "usdt:tron", "usdc:polygon"],
    "order_id": "SHOP-8812",
    "success_url": "https://shop.example.com/thanks?order=8812",
    "cancel_url": "https://shop.example.com/cart",
    "customer": { "email": "buyer@example.com" },
    "line_items": [ { "name": "Mechanical keyboard", "quantity": 1, "unit_amount": "129.00" } ],
    "redirect_on": "confirming",
    "branding": { "theme": "auto", "merchant_name": "Example Shop", "logo_url": "https://shop.example.com/logo.png" },
    "metadata": { "woocommerce_order_id": "8812" }
  }'
```

A checkout session accepts every field an invoice does (see `InvoiceCreateRequest`) plus:

| Field | Description |
|-------|-------------|
| `line_items[]` | Shown on the page. Must sum to `amount` or the API returns `parameter_invalid`. Optional. |
| `redirect_on` | `confirming` (default - redirect as soon as enough is seen in the mempool/first block) or `paid` (wait for full confirmations). |
| `locale` | BCP-47 or `auto`. |
| `branding` | `theme` (light/dark/auto), `logo_url`, `primary_color`, `merchant_name`. Dashboard defaults apply when omitted. |
| `collect_email` | Ask the customer for an email on the page (for refund contact). Default false. |
| `allow_asset_change` | Let the customer switch asset after an address is shown. Default true. |

`success_url` is required. `{CHECKOUT_SESSION_ID}` and `{INVOICE_ID}` placeholders in
`success_url`/`cancel_url` are substituted on redirect, e.g.
`https://shop.example.com/thanks?cs={CHECKOUT_SESSION_ID}`.

## The page

`https://pay.coinvello.com/c/cs_5TgH8kLp2Q`

* Asset picker (only the `accepted_assets` with enabled wallets), amount in fiat and crypto,
  countdown to `expires_at`, locked rate.
* QR code (`qr_payload`), copyable address and amount, "Open in wallet" deep link (`payment_uri`).
* One-click pay buttons: MetaMask / Rabby / any injected EVM wallet and WalletConnect for EVM
  chains (switches network via `network_id`, calls `transfer` for tokens), Phantom / Solflare
  for Solana, TronLink for Tron. These are implemented in the hosted page and simply submit
  the `payment_uri` parameters through the wallet - CoinVello never holds the funds.
* Live status via server-sent events: "waiting", "detected - confirming (1/19)", "paid".
* On `underpaid`: shows the remaining amount and a fresh countdown; on `overpaid` / late:
  shows the refund-claim form (`refund_claim_url`).
* Mobile-first; `theme: auto` follows the OS. Brand defaults use CoinVello's own palette
  (navy `#0B3B5C`, deep sky `#0B5C96`, Coin V mark; Sora / Inter / JetBrains Mono, see `brand/tokens.css`) unless the
  merchant sets `branding` in the dashboard.

Hosted pages expose nothing beyond what the customer needs; they cannot be used to read
other invoices or your account.

### `lang` and `currency` query parameters

The page ships in 13 languages (English, Spanish, French, German, Portuguese (Brazil),
Italian, Dutch, Japanese, Chinese (Simplified), Korean, Turkish, Arabic with RTL layout,
Russian) and lets the payer switch language (globe control) and the fiat currency the amount
is *displayed* in. Two optional query parameters on the checkout URL preset both:

| Query parameter | Value | Effect |
|-----------------|-------|--------|
| `lang` | BCP-47 tag, e.g. `de`, `pt-BR`, `zh-CN` | Initial UI language. Unsupported tags fall back by language prefix (`pt-PT` → `pt-BR`), then to English. |
| `currency` | ISO 4217 code, e.g. `EUR` | Initial display currency, honoured only if it appears in the session's `display_rates`. |

```
https://pay.coinvello.com/c/cs_5TgH8kLp2Q?lang=es&currency=MXN
```

Resolution order on the page: `lang` → the payer's remembered choice (browser storage) →
`locale_hints.merchant_locale` → the browser's languages → English. For the currency:
`currency` → remembered choice → a currency implied by the browser locale (`es-MX` → MXN,
`ja` → JPY, ...) → `locale_hints.suggested_currency` → the session currency. The embeddable
widget forwards its `locale` / `displayCurrency` options as these parameters.

The amount due is always shown in the session's `currency`; the display currency only adds an
approximate figure next to it ("≈ €46.12 at today's rate") computed from `display_rates`
(see "Language and display currency" below). It never changes the amount owed or the crypto
amount, and the selector is hidden when `display_rates` is absent. Wallet and network names
are not translated.

## Public endpoints used by the hosted page and widget

The page and the embeddable widget never see your API key. They use two **unauthenticated,
CORS-open** endpoints that take only the session id (ids are unguessable; treat the URL like
a bearer token for *viewing* the payment page):

### `GET /checkout-sessions/{id}/public`

Returns a `PublicCheckoutSession` - a redacted projection containing only what the payer must
see. Credit purchases are served from the same endpoint with their `cpu_` id (`purpose: credits`).

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | `cs_...` or `cpu_...` |
| `object` | `"checkout_session.public"` | |
| `purpose` | `payment` \| `credits` | `credits` = merchant buying CoinVello credits; `merchant` then describes CoinVello |
| `merchant` | `{ name, logo_url? }` | From dashboard branding / `branding.merchant_name` |
| `amount`, `currency` | decimal string, ISO code or asset id | |
| `description` | string \| null | e.g. `Order #10042`, `5,000 credits` |
| `status` | `pending` \| `confirming` \| `paid` \| `underpaid` \| `overpaid` \| `expired` \| `cancelled` | invoice `new` is reported as `pending` |
| `expires_at` | date-time | |
| `payment_options[]` | `PublicPaymentOption` | every `PaymentOption` field **plus aliases**: `uri` (= `payment_uri`), `chain_id` (= `network_id`, string), `token_contract` (= `contract_address`), `rate_locked_until`, `explorer_url`, `qr_svg` (inline SVG of `qr_payload` for server-rendered pages); `decimals`, `amount_minor`, `rate` are already canonical |
| `paid` | `InvoicePaidSummary` \| null | aggregate received / due / remaining / confirmations |
| `payments[]` | `{ id, chain, asset, symbol, tx_hash, amount, amount_minor, status, confirmations, required_confirmations, explorer_url, detected_at, confirmed_at }` | |
| `success_url`, `cancel_url` | string \| null | |
| `redirect_on` | `confirming` \| `paid` | |
| `address_manifest` | `AddressManifest` \| null | ed25519 merchant-signed `{merchant_id, issued_at, addresses}` with `alg`, `pubkey_id`, `signature`, plus informational `wallet_ids`; the page re-verifies it with WebCrypto |
| `balance_delta` | string \| null | shortfall (negative) / excess (positive) in `currency` when under/overpaid |
| `branding` | `{ theme, primary_color }` | |
| `display_rates` | `DisplayRates` \| null | 1 unit of `currency` in other fiats as decimal strings (indicative); the page hides the currency selector without it |
| `locale_hints` | `{ merchant_locale, suggested_currency }` \| null | Merchant defaults for the payer UI; `?lang=` / `?currency=` and the payer's own choice take precedence |
| `locale`, `updated_at` | | |

Never present: `metadata`, `customer`, API keys, webhook data, anything about the merchant
account. Response is `Cache-Control: no-store`.

### `GET /checkout-sessions/{id}/events` (SSE)

`text/event-stream`. Emits `event: status` with the full `PublicCheckoutSession` as `data`
immediately on connect and on every change (payment detected, confirmations, paid, expired...),
and `event: heartbeat` (`{"ts"}`) every 15 s. Frames carry an incrementing `id:`; send
`Last-Event-ID` to resume. The stream closes shortly after a terminal status.

```js
const es = new EventSource(`${API}/checkout-sessions/${id}/events`);
es.addEventListener("status", (e) => render(JSON.parse(e.data)));
```

**Polling fallback:** when `EventSource` is missing or the stream errors, poll `/public` every
5 s while non-terminal, backing off to 60 s on errors, and keep a slow 30 s poll even while
SSE is connected as a safety net. The hosted page does exactly this.

The stream is a UX channel. Fulfil orders from the signed `invoice.paid` webhook.

### Field-name notes for the checkout SDK

Canonical names are `payment_uri`, `network_id`, `contract_address`, and `asset` as
`<asset>:<chain>` with `symbol` for display. The public projection adds the SDK's `uri`,
`chain_id` and `token_contract` aliases. Two differences the SDK should absorb: `chain_id` is
a **string** (coerce with `Number()`), and `asset` is the asset id - use `symbol` for the
ticker. `purpose` values are `payment` / `credits`.

## Language and display currency

The public session carries two things for the payer UI:

* `display_rates` - fiat rates with `base` = the invoice currency (omitted for crypto-priced invoices),
  so the page can show "≈ 45.90 EUR" next to the USD price. Indicative only; the invoice settles at the
  crypto amount locked on it. The same table is available to any page at `GET /v1/rates/display?base=USD`
  (no auth, CORS-open, cached 5 minutes) - the pricing page uses it.
* `locale_hints` - `{ merchant_locale, suggested_currency }` from the merchant's defaults
  (`PATCH /v1/account {"locale": "de-CH", "display_currency": "CHF"}`), or null. The hosted page
  pre-selects them and still lets the payer switch.

## After payment

The page redirects to `success_url` when the invoice reaches `redirect_on`. **Do not fulfil
on the redirect** - anybody can type that URL. Fulfil on the `invoice.paid` webhook (or
`checkout_session.completed`, which fires at the same time and carries the session).

`GET /checkout-sessions/{id}?expand=invoice` returns the session with the full invoice
embedded, useful on your thank-you page to display what was paid.

## Embedded mode

For an in-page experience instead of a redirect, load the widget with a script tag or install it
from npm (`npm install @coinvello/checkout`, then `import { CoinVello } from '@coinvello/checkout'`):

```html
<script src="https://pay.coinvello.com/sdk/v1/checkout.js"></script>
<div id="cv-checkout"></div>
<script>
  CoinVello.mount("#cv-checkout", { sessionId: "cs_5TgH8kLp2Q", onPaid: () => location.href = "/thanks" });
</script>
```

`CoinVello.redirectToCheckout({ sessionId })` sends the payer to the hosted page instead, and
`<coinvello-pay-button session-id="cs_5TgH8kLp2Q" mode="modal"></coinvello-pay-button>` renders a pay
button without any JavaScript of your own (`mode="redirect"` is the default).

The widget needs only the session id: there are no publishable keys, and it refuses an API key if one
is passed in. It talks only to `pay.coinvello.com`; your API key stays on your server. Package page:
<https://www.npmjs.com/package/@coinvello/checkout>.

## Expiry and cancellation

* Sessions expire with their invoice (`expires_in`, default 30 minutes). An expired session
  shows an "expired - return to shop" page linking to `cancel_url`.
* `POST /checkout-sessions/{id}/expire` kills it early (e.g. customer cancelled the order).
* Status: `open` -> `complete` (invoice paid/confirming per `redirect_on`) or `expired`.

## Fees

Identical to a plain invoice: a confirmed payment consumes `clamp(round(fiat_usd x 30 bps / $0.01), 2, 2000)` credits (a $49.99 order = 15 credits). Hosting is free. See [credits.md](credits.md).
