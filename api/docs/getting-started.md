# Getting started

CoinVello is a **non-custodial** crypto payment processor. You keep your keys; CoinVello
generates receiving addresses from your xpub (BTC) or watches addresses you own
(Ethereum & EVM chains, Solana, Tron), detects payments on-chain, and tells you about them
through signed webhooks. CoinVello never holds your customers' funds or your fiat.

Fees are paid with prepaid **processing credits** (bought in crypto or by card), or on pay as you
go (0.4% split on-chain, open to every account, not on Bitcoin) if you would rather not prepay (see
[credits.md](credits.md)). There are no free live credits.

## No KYC, no KYB

Onboarding is **email + API key**. There is no identity or business verification step, and
the API collects no identity information about your payers anywhere. The only place any
verification happens is on a **partner's side** if you choose to connect an off-ramp account
(see [offramp.md](offramp.md)); that relationship is between you and the partner.

## 1. Get your API keys

1. Sign up at <https://coinvello.com/app/login.php?mode=signup> with an email address.
2. Go to **Settings -> API keys**. You get two secret keys:
   * `cv_test_...` - test mode. Testnets only, plus the `/test/simulate_payment` helper.
   * `cv_live_...` - live mode. Mainnets, real money.
3. Copy a key from **Settings → API keys** (shown after a second-factor check). Store it in a secrets manager, never in client-side code.

Everything in test mode is a separate universe: test wallets, test invoices, test webhooks,
test credits (free, unlimited). Objects created with a test key are invisible to a live key
and vice-versa. See [testing.md](testing.md).

## 2. Register a wallet

A wallet is usable as soon as it is registered, in live and test mode. Addresses are validated
strictly per chain; proving ownership with a signed message is optional.

```bash
curl https://api.coinvello.com/v1/wallets \
  -H "Authorization: Bearer cv_test_51Hq..." \
  -H "Content-Type: application/json" \
  -d '{
    "type": "xpub",
    "chain": "bitcoin",
    "label": "Shop BTC",
    "xpub": "vpub5Y6cjg7...",
    "derivation_path": "m/84'"'"'/1'"'"'/0'"'"'"
  }'
```

For EVM / Solana / Tron, register an address instead:

```bash
curl https://api.coinvello.com/v1/wallets \
  -H "Authorization: Bearer cv_test_51Hq..." \
  -H "Content-Type: application/json" \
  -d '{
    "type": "address",
    "chain": "polygon",
    "label": "Polygon hot wallet",
    "address": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "assets": ["usdc:polygon", "usdt:polygon"]
  }'
```

`assets` takes ids from `GET /assets`, which lists the assets of your key's mode: native coins plus
USDC, USDT, DAI, EURC, PYUSD and USDG on the chains that issue them, plus Bitcoin tokens (WBTC, cbBTC, BTCB,
BTC.b) on EVM chains and Solana. A few tokens, including all the Bitcoin tokens, have no testnet contract
and are live-only (see [testing.md](testing.md)), so a test key does not list or accept them.

How to export an xpub from Ledger, Trezor, Sparrow, Electrum, BlueWallet etc. is in
[wallets-and-xpubs.md](wallets-and-xpubs.md), together with the address checks and the optional
signed-message verification.

## 3. Create your first invoice

```bash
curl https://api.coinvello.com/v1/invoices \
  -H "Authorization: Bearer cv_test_51Hq..." \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 7f0c0a4e-6b7e-4e21-9f9c-2b2a0d7a2a51" \
  -d '{
    "amount": "49.99",
    "currency": "USD",
    "accepted_assets": ["btc:bitcoin", "usdc:polygon"],
    "order_id": "WC-10042",
    "success_url": "https://shop.example.com/thanks",
    "cancel_url": "https://shop.example.com/cart",
    "metadata": { "woocommerce_order_id": "10042" }
  }'
```

Response (abridged):

```json
{
  "id": "inv_9XyZ12AbC3",
  "object": "invoice",
  "status": "new",
  "amount": "49.99",
  "currency": "USD",
  "hosted_url": "https://pay.coinvello.com/i/inv_9XyZ12AbC3",
  "payment_options": [
    {
      "asset": "btc:bitcoin",
      "address": "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx",
      "amount": "0.00074230",
      "payment_uri": "bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.0007423",
      "qr_payload": "bitcoin:tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx?amount=0.0007423",
      "required_confirmations": 1
    },
    {
      "asset": "usdc:polygon",
      "address": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
      "amount": "50.000518",
      "payment_uri": "ethereum:0x41E9...7582@80002/transfer?address=0x8ba1...BA72&uint256=50000518",
      "qr_payload": "ethereum:0x41E9...7582@80002/transfer?address=0x8ba1...BA72&uint256=50000518",
      "required_confirmations": 64
    }
  ],
  "expires_at": "2026-10-21T10:30:00Z"
}
```

Show the customer either the `hosted_url` (zero UI work) or render `payment_options`
yourself (QR code from `qr_payload`, deep link from `payment_uri`). If you prefer a fully
hosted flow with line items and branding, use [Checkout Sessions](checkout.md).

## 4. Simulate a payment (test mode)

```bash
curl https://api.coinvello.com/v1/test/simulate_payment \
  -H "Authorization: Bearer cv_test_51Hq..." \
  -H "Content-Type: application/json" \
  -d '{ "invoice_id": "inv_9XyZ12AbC3", "asset": "usdc:polygon", "confirmations": 64 }'
```

The invoice goes `new -> confirming -> paid` and your webhook endpoint receives
`payment.detected`, `invoice.confirming` and `invoice.paid`.

## 5. Receive webhooks

Create an endpoint (store the returned `secret`, it is shown once):

```bash
curl https://api.coinvello.com/v1/webhooks \
  -H "Authorization: Bearer cv_test_51Hq..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://shop.example.com/webhooks/coinvello",
    "events": ["invoice.paid", "invoice.confirming", "invoice.expired", "invoice.underpaid", "payment.detected"]
  }'
```

Every delivery carries a `CoinVello-Signature` header:

```
CoinVello-Signature: t=1760000000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

The signed string is `<t>.<raw request body>` and the signature is HMAC-SHA256 with your
endpoint secret. Reject anything older than 5 minutes and dedupe on the event `id`.
Full details and rotation handling in [webhooks.md](webhooks.md).

### Verify in Node

```js
import crypto from "node:crypto";

export function verifyCoinVelloSignature(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => { const [k, ...v] = kv.split("="); return [k.trim(), v.join("=")]; })
  );
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new Error("timestamp outside tolerance");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const sigs = header.split(",").filter((p) => p.trim().startsWith("v1=")).map((p) => p.trim().slice(3));
  const ok = sigs.some((s) => s.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(s, "hex"), Buffer.from(expected, "hex")));
  if (!ok) throw new Error("signature mismatch");
  return JSON.parse(rawBody);
}

// Express: app.post("/webhooks/coinvello", express.raw({ type: "application/json" }), (req, res) => {
//   const event = verifyCoinVelloSignature(req.body.toString("utf8"), req.get("CoinVello-Signature"), process.env.CV_WEBHOOK_SECRET);
//   if (event.type === "invoice.paid") fulfil(event.data.object.order_id);
//   res.sendStatus(200);
// });
```

### Verify in PHP

```php
<?php
function coinvello_verify(string $rawBody, string $header, string $secret, int $tolerance = 300): array {
    $t = null; $sigs = [];
    foreach (explode(',', $header) as $pair) {
        [$k, $v] = array_pad(explode('=', trim($pair), 2), 2, '');
        if ($k === 't') { $t = (int) $v; }
        if ($k === 'v1') { $sigs[] = $v; }
    }
    if (!$t || abs(time() - $t) > $tolerance) {
        throw new RuntimeException('timestamp outside tolerance');
    }
    $expected = hash_hmac('sha256', $t . '.' . $rawBody, $secret);
    foreach ($sigs as $sig) {
        if (hash_equals($expected, $sig)) {
            return json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
        }
    }
    throw new RuntimeException('signature mismatch');
}

// $event = coinvello_verify(file_get_contents('php://input'), $_SERVER['HTTP_COINVELLO_SIGNATURE'], getenv('CV_WEBHOOK_SECRET'));
```

### Verify in Python

```python
import hmac, hashlib, json, time

def verify_coinvello(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> dict:
    parts = dict(p.strip().split("=", 1) for p in header.split(","))
    t = int(parts.get("t", "0"))
    if not t or abs(time.time() - t) > tolerance:
        raise ValueError("timestamp outside tolerance")
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    sigs = [p.strip()[3:] for p in header.split(",") if p.strip().startswith("v1=")]
    if not any(hmac.compare_digest(expected, s) for s in sigs):
        raise ValueError("signature mismatch")
    return json.loads(raw_body)
```

## 6. Go live

1. Confirm your email address (the link in the sign-up email). Live API keys and live-mode writes
   need it (`email_verified` on `GET /account`); until then they return `403 email_unverified`.
2. Register your live wallets with a `cv_live_` key (for xpubs, compare `first_address` with your
   wallet's first receive address).
3. Buy processing credits: `GET /credits/bundles`, then `POST /credits/purchases` and pay the
   returned payment option (or open `checkout_url`), or pay by card with a card saved in the
   dashboard (`payment_method`). See [credits.md](credits.md). Without credits,
   live invoices need pay as you go: the account switches to it automatically when credits run out
   (`auto_switch_to_pay_as_you_go`, on by default, where pay as you go is open to the account);
   otherwise invoice creation returns `402 insufficient_credits`.
4. Create a live webhook endpoint (HTTPS required).
5. Swap the API key in your integration. That's it - there is no account review step.
6. Optional: invite your team (`POST /team/members` with `email` and `role`: `admin`, `developer` or
   `viewer`; dashboard session only). Members sign in with their own password and must enrol 2FA.
   `developer` covers invoices, checkout, webhooks, API keys, test tools and exports, not wallets,
   billing, plan or team; `viewer` is read-only. Owner and admins can read the append-only activity
   log (`GET /account/activity`).

## Next

* [authentication.md](authentication.md) - key types, restricted keys, scopes
* [errors.md](errors.md) - error envelope and codes
* [idempotency.md](idempotency.md), [pagination.md](pagination.md), [rate-limits.md](rate-limits.md), [versioning.md](versioning.md)
* [checkout.md](checkout.md) - hosted checkout on pay.coinvello.com
* [conversions.md](conversions.md), [offramp.md](offramp.md) - optional non-custodial flows
* [sdks.md](sdks.md) - Node, PHP and Python SDKs
* `../openapi.yaml` - the full OpenAPI 3.1 reference
