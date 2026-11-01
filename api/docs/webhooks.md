# Webhooks

Webhooks are how CoinVello tells you that something happened on-chain. Fulfil orders from
webhooks, never from a browser redirect.

## Endpoints

```bash
curl https://api.coinvello.com/v1/webhooks \
  -H "Authorization: Bearer cv_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://shop.example.com/webhooks/coinvello",
    "description": "WooCommerce production",
    "events": ["invoice.paid", "invoice.confirming", "invoice.expired", "invoice.underpaid", "invoice.overpaid", "payment.detected"]
  }'
```

The response contains `secret` (`whsec_` + 64 hex chars). **It is returned only once.**
Store it next to your API key.

* Live endpoints must be HTTPS with a valid certificate. Test endpoints may be `http://localhost`.
* Up to 16 endpoints per mode. Use `"events": ["*"]` to receive everything.
* `PATCH /webhooks/{id}` to change url/events/enabled; `DELETE` to remove.
* `POST /webhooks/{id}/test` sends a signed `ping` (or any event type) so you can test your handler before going live.

### Two-factor step-up

Webhook endpoints decide who learns about payments, so in the **dashboard** creating,
editing, deleting an endpoint or rotating its secret requires a recent second-factor
verification (5-minute step-up window, see [security.md](security.md)). API-key calls need
the `webhooks:write` scope and trigger an owner notification email.

## Event payload

Every delivery is a JSON `event` object:

```json
{
  "id": "evt_1Nz7Qw3Er9",
  "object": "event",
  "type": "invoice.paid",
  "livemode": true,
  "api_version": "2026-10-01",
  "created_at": "2026-10-21T10:04:12Z",
  "data": {
    "object": { "id": "inv_9XyZ12AbC3", "object": "invoice", "status": "paid", "...": "..." },
    "previous_attributes": { "status": "confirming" }
  },
  "request": { "id": "req_...", "idempotency_key": "..." },
  "pending_webhooks": 1
}
```

`data.object` is the full resource as it was when the event fired. `previous_attributes`
is present on state changes. For `payment.*` events, `data.invoice_status` gives the
invoice status after the payment was applied.

## Event types

| Type | Fires when | `data.object` |
|------|-----------|---------------|
| `invoice.created` | Invoice created | invoice |
| `invoice.pending` | Payment detected but insufficient or unconfirmed | invoice |
| `invoice.confirming` | Enough paid, waiting for confirmations - safe to show "payment received" | invoice |
| `invoice.paid` | Confirmed - **fulfil the order** | invoice |
| `invoice.underpaid` | Confirmed below amount minus tolerance | invoice |
| `invoice.overpaid` | Confirmed above amount plus tolerance | invoice |
| `invoice.expired` | `expires_at` reached without enough payment | invoice |
| `invoice.cancelled` | Merchant cancelled | invoice |
| `invoice.refund_requested` | Refund pending for this invoice | invoice |
| `payment.detected` | Tx seen (0+ conf) | payment |
| `payment.confirmed` | Tx reached required confirmations | payment |
| `payment.failed` | Tx dropped (reorg / RBF / revert) | payment |
| `wallet.verified` | Wallet signature verified | wallet |
| `conversion.completed` / `conversion.failed` | Swap settled / failed | conversion |
| `offramp.completed` / `offramp.failed` | Partner payout done / failed | offramp_payout |
| `refund.completed` / `refund.failed` | Refund tx confirmed / failed | refund |
| `credits.low` | Balance under threshold | credits_balance |
| `credits.purchase.paid` / `.underpaid` / `.expired` | Credit purchase lifecycle | credit_purchase |
| `credits.added` | Credits credited to balance | credit_ledger_entry (+ `data.balance`) |
| `checkout_session.completed` / `.expired` | Hosted checkout outcome | checkout_session |
| `receiver.deployed` | A pay-as-you-go receiver was deployed (EVM, Tron; inside its first sweep) | receiver |
| `sweep.confirmed` / `.failed` | A receiver's balance was split on-chain between your wallet and CoinVello, or the sweep reverted (nothing moved) | sweep |

Full schemas and example bodies are in `openapi.yaml` under `webhooks:`.

## Delivery

```
POST https://shop.example.com/webhooks/coinvello
Content-Type: application/json
User-Agent: CoinVello-Webhooks/1.0 (+https://coinvello.com/developers)
CoinVello-Signature: t=1760000000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
CoinVello-Event-Id: evt_1Nz7Qw3Er9
CoinVello-Event-Type: invoice.paid
CoinVello-Webhook-Id: whe_2JxK9vL3mQ
CoinVello-Delivery-Id: whd_4Hn7Pq2W
CoinVello-Delivery-Attempt: 1
```

Respond with any **2xx within 10 seconds**. Do the work asynchronously if it is slow.
Anything else (timeout, 3xx, 4xx, 5xx, connection error) counts as a failure.

### Retry schedule

| Attempt | Delay after previous |
|---------|---------------------|
| 1 | immediate |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |
| 6 | 6 hours |
| 7 | 12 hours |
| 8 | 24 hours |
| 9 | 24 hours |

About 70 hours total. After attempt 9 the delivery is `exhausted`. An endpoint becomes
`degraded` after 3 consecutive failures and is **auto-disabled after 72 hours** of
continuous failure (you get an email). Re-enable with `PATCH /webhooks/{id} {"enabled": true}`
and backfill from `GET /events`.

`GET /webhooks/{id}/deliveries` lists attempts with response codes; `POST .../deliveries/{id}/retry`
re-sends one now.

Ordering is **not guaranteed**. `payment.detected` may arrive after `invoice.confirming`.
Always act on the state in `data.object`, not on the sequence of events.

Deliveries come from these IPs (also at `GET https://api.coinvello.com/v1/webhooks/ips`):
`52.17.0.0/24`, `18.185.0.0/24` (illustrative; the live list is authoritative).

## Signature scheme

```
CoinVello-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>[,v1=<hex HMAC-SHA256>]
```

1. `t` is the Unix timestamp (seconds) when CoinVello signed the delivery.
2. The **signed payload** is the ASCII string `t`, a literal `.`, and the **raw request body
   bytes** exactly as sent: `"<t>.<raw_body>"`.
3. `v1` is `hex(HMAC_SHA256(key = endpoint secret as UTF-8, including the whsec_ prefix, message = signed payload))`.
4. During a secret rotation grace period there are **two** `v1=` pairs (old and new secret).
   The signature is valid if **any** `v1` matches.

Verification steps:

1. Read the raw body **before** any JSON parsing or framework body-parsing middleware
   re-serialises it. Whitespace changes break the HMAC.
2. Parse the header; reject if `t` is missing or `|now - t| > 300 s` (replay protection).
3. Compute the expected HMAC and compare with a **constant-time** comparison against each `v1`.
4. Dedupe on `event.id` (store processed ids for at least 3 days). Retries re-send the same
   event id with a fresh `t`/signature.
5. Only then parse the JSON and act.

Never trust `data.object` for amounts if you can avoid it in high-value flows: re-fetch
`GET /invoices/{id}` with your API key. (The signature already makes the payload trustworthy;
re-fetching protects you against your own secret leaking.)

### Node (Express)

```js
import express from "express";
import crypto from "node:crypto";

const app = express();
const SECRET = process.env.CV_WEBHOOK_SECRET; // whsec_...

function verify(rawBody, header, secret, toleranceSec = 300) {
  if (!header) throw new Error("missing CoinVello-Signature");
  let t = 0; const sigs = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("="); const v = rest.join("=");
    if (k === "t") t = Number(v);
    if (k === "v1") sigs.push(v);
  }
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new Error("timestamp outside tolerance");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  const ok = sigs.some((s) => {
    const b = Buffer.from(s, "hex");
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
  if (!ok) throw new Error("signature mismatch");
  return JSON.parse(rawBody.toString("utf8"));
}

app.post("/webhooks/coinvello", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = verify(req.body, req.get("CoinVello-Signature"), SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
  if (await alreadyProcessed(event.id)) return res.sendStatus(200);

  switch (event.type) {
    case "invoice.paid":
      await markOrderPaid(event.data.object.order_id, event.data.object);
      break;
    case "invoice.underpaid":
    case "invoice.expired":
      await flagOrder(event.data.object.order_id, event.type);
      break;
  }
  await rememberProcessed(event.id);
  res.sendStatus(200);
});
```

With the Node SDK: `const event = coinvello.webhooks.constructEvent(rawBody, header, secret);`

### PHP (plain / WordPress)

```php
<?php
// Raw body is essential: do NOT use $_POST.
$raw    = file_get_contents('php://input');
$header = $_SERVER['HTTP_COINVELLO_SIGNATURE'] ?? '';
$secret = getenv('CV_WEBHOOK_SECRET');

function coinvello_verify(string $raw, string $header, string $secret, int $tolerance = 300): array
{
    $t = 0; $sigs = [];
    foreach (explode(',', $header) as $pair) {
        $kv = explode('=', trim($pair), 2);
        if (count($kv) !== 2) continue;
        if ($kv[0] === 't')  { $t = (int) $kv[1]; }
        if ($kv[0] === 'v1') { $sigs[] = $kv[1]; }
    }
    if ($t === 0 || abs(time() - $t) > $tolerance) {
        throw new RuntimeException('timestamp outside tolerance');
    }
    $expected = hash_hmac('sha256', $t . '.' . $raw, $secret);
    foreach ($sigs as $sig) {
        if (hash_equals($expected, $sig)) {
            return json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
        }
    }
    throw new RuntimeException('signature mismatch');
}

try {
    $event = coinvello_verify($raw, $header, $secret);
} catch (Throwable $e) {
    http_response_code(400);
    exit('Webhook error: ' . $e->getMessage());
}

if ($event['type'] === 'invoice.paid') {
    $orderId = $event['data']['object']['order_id'];
    // mark order paid; make this idempotent on $event['id']
}
http_response_code(200);
```

With the PHP SDK: `$event = \CoinVello\Sdk\Webhooks::constructEvent($raw, $header, $secret);`

### Python (Flask)

```python
import hmac, hashlib, json, time
from flask import Flask, request, abort

app = Flask(__name__)
SECRET = os.environ["CV_WEBHOOK_SECRET"]

def verify(raw: bytes, header: str, secret: str, tolerance: int = 300) -> dict:
    t, sigs = 0, []
    for part in header.split(","):
        k, _, v = part.strip().partition("=")
        if k == "t": t = int(v)
        elif k == "v1": sigs.append(v)
    if not t or abs(time.time() - t) > tolerance:
        raise ValueError("timestamp outside tolerance")
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, s) for s in sigs):
        raise ValueError("signature mismatch")
    return json.loads(raw)

@app.post("/webhooks/coinvello")
def coinvello_webhook():
    try:
        event = verify(request.get_data(), request.headers.get("CoinVello-Signature", ""), SECRET)
    except ValueError as e:
        abort(400, str(e))
    if event["type"] == "invoice.paid":
        mark_paid(event["data"]["object"]["order_id"])
    return "", 200
```

With the Python SDK: `event = coinvello.Webhooks.construct_event(raw, header, secret)`.

## Replaying events

Added an endpoint after the fact, or fixed a receiver that was returning 500 for an hour? Replay:

```bash
# one event, to every subscribed endpoint (or pass {"webhook_id": "whe_..."} for one)
curl -X POST https://api.coinvello.com/v1/events/evt_1Nz7Qw3Er9/resend -H "Authorization: Bearer cv_live_..."

# everything this endpoint subscribes to from a point in time (max 1,000 events per call, oldest first)
curl -X POST https://api.coinvello.com/v1/webhooks/whe_2JxK9vL3mQ/replay \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{"since": "2026-10-21T09:00:00Z", "types": ["invoice.paid"]}'
```

Replayed deliveries keep the **same `event.id`**, carry `replayed: true` in the delivery object and
the `CoinVello-Delivery-Replayed: true` header, and are signed with a fresh timestamp like any
delivery. A receiver that dedupes on `event.id` (as recommended above) ignores them automatically.
`GET /events` is the other half: list what you missed, then resend.

## Rotating a secret

```bash
curl -X POST https://api.coinvello.com/v1/webhooks/whe_2JxK9vL3mQ/rotate_secret \
  -H "Authorization: Bearer cv_live_..." -d '{"grace_period_seconds": 86400}'
```

For the grace period deliveries carry two `v1=` signatures. Deploy the new secret any time
within the window; verifiers that accept "any v1 matches" need no code change.

## Local development

Run the [reference server](../reference-server/README.md) and point it at your handler:

```bash
cd api/reference-server && npm install && npm run dev
curl -X POST localhost:4242/v1/webhooks -H "Authorization: Bearer cv_test_mock" \
  -d '{"url":"http://localhost:3000/webhooks/coinvello","events":["*"]}'
```

Or expose your local handler with a tunnel (ngrok, cloudflared) and create a test-mode
endpoint with the tunnel URL; `POST /test/simulate_payment` will then hit it with real,
signed events.
