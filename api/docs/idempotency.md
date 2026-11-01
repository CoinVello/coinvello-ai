# Idempotency

Networks fail. If you create an invoice and the connection drops before you read the
response, you don't know whether the invoice exists. Idempotency keys make retries safe.

## How it works

Send an `Idempotency-Key` header on any `POST` request:

```
POST /v1/invoices
Idempotency-Key: 7f0c0a4e-6b7e-4e21-9f9c-2b2a0d7a2a51
```

* The first request with a key is executed and its response (status + body) is stored for
  **24 hours**, scoped to your API key and mode.
* A repeat with the **same key and same body** returns the stored response unchanged, with
  `Idempotency-Replayed: true`. Nothing is executed twice - no second invoice, no second
  address derived, no second credit charged.
* A repeat with the **same key and a different body** returns
  `409 idempotency_error / idempotency_key_reused`.
* A repeat while the first request is still running returns
  `409 idempotency_key_in_progress`; back off a second and retry.

Keys are any string up to 255 characters. Use a UUIDv4, or a deterministic value tied to
your own object such as `order-10042-invoice`. Deterministic keys are great for plugins: if
the shopper refreshes the checkout page, you re-send the same request and get the same
invoice back.

## Which endpoints support it

Every `POST` endpoint that creates or transitions an object: invoices (create/cancel/expire),
wallets, webhooks, credits purchases, rate locks, conversions, off-ramp payouts, checkout
sessions, refunds, simulate_payment, and admin writes. `GET`, `PATCH`, `PUT` and `DELETE`
are naturally idempotent and ignore the header.

## Errors are stored too

If the first request failed with a 4xx error, the same error is replayed. If it failed with a
5xx, nothing is stored and the retry executes fresh, which is what you want.

## Recommended retry policy

```
attempt 1 -> network error / 5xx / 409 in_progress
wait 0.5 s, retry with the same key
wait 1 s, retry
wait 2 s, retry
give up and surface to the operator (the key is still valid for 24 h)
```

The official SDKs do this automatically: they generate a UUID per create call, retry up to
3 times on connection errors, 409 `idempotency_key_in_progress`, 429 and 5xx, and let you
pass your own key with `{ idempotencyKey: "..." }`.
