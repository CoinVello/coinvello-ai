# @coinvello/sdk (Node / TypeScript)

Minimal, typed, `fetch`-based client for the [CoinVello API](../../openapi.yaml). Node 18+.
No runtime dependencies.

```bash
npm install @coinvello/sdk
```

```ts
import { CoinVello } from "@coinvello/sdk";

const cv = new CoinVello(process.env.COINVELLO_API_KEY!); // cv_live_... or cv_test_...

const invoice = await cv.invoices.create({
  amount: "49.99",
  currency: "USD",
  accepted_assets: ["btc:bitcoin", "usdt:tron"],
  order_id: "WC-10042",
  success_url: "https://shop.example.com/thanks",
}, { idempotencyKey: "order-10042-invoice" });

console.log(invoice.hosted_url, invoice.payment_options[0].qr_payload);
```

## Resources

`cv.invoices` (create, get, list, update, cancel, expire, listPayments) ·
`cv.payments` · `cv.wallets` (create, verify flow, addresses) · `cv.webhooks` (CRUD, rotateSecret,
test, deliveries, **constructEvent**) · `cv.credits` (balance, bundles, purchase, ledger) ·
`cv.rates` (quote, lock) · `cv.conversions` · `cv.offramp` · `cv.checkoutSessions` ·
`cv.refunds` · `cv.events` · `cv.assets` · `cv.records` (list, retrieve, summary) · `cv.exports` (create, list,
retrieve, delete, download) · `cv.test.simulatePayment`.

Method names map to `operationId`s in the OpenAPI document.

## Records and exports

Every payment, fee and credit purchase is a record valued when it happened; export a period for your accountant or tax software.

```ts
import { writeFileSync } from "node:fs";
const period = { start: "2026-07-01", end: "2026-10-01" }; // last quarter, in your timezone
let exp = await cv.exports.create({ dataset: "records", format: "xlsx", period }, { idempotencyKey: "records-2026-q3" });
while (exp.status === "queued" || exp.status === "processing") { await new Promise((r) => setTimeout(r, 2000)); exp = await cv.exports.retrieve(exp.id); }
if (exp.status !== "ready") throw new Error(`export ${exp.status}: ${exp.failure_reason}`);
writeFileSync(exp.file!.name, await cv.exports.download(exp.id)); // bytes; check exp.file.sha256
```

With a test key, rows from `cv.test.simulatePayment` only appear with `include_simulated: true` (on `records.list`, `records.summary` and `exports.create`).

## Webhooks

```ts
import express from "express";
app.post("/webhooks/coinvello", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const event = cv.webhooks.constructEvent(req.body, req.get("CoinVello-Signature"), process.env.CV_WEBHOOK_SECRET!);
    if (event.type === "invoice.paid") fulfil(event.data.object);
    res.sendStatus(200);
  } catch (e) {
    res.status(400).send((e as Error).message);
  }
});
```

`constructEvent(rawBody, header, secret, tolerance = 300)` checks the timestamp window,
verifies every `v1=` HMAC-SHA256 in constant time (rotation-safe) and returns the parsed event.
`signPayload(body, secret)` produces a header for tests.

## Options

```ts
new CoinVello(key, {
  baseUrl: "http://localhost:4242/v1", // reference-server for local tests
  apiVersion: "2026-10-01",
  timeoutMs: 30_000,
  maxRetries: 3,          // on connection errors, 429, 5xx, 409 idempotency_key_in_progress
  fetch: customFetch,
});
```

## Errors

All errors extend `CoinVelloError` (`type`, `code`, `message`, `param`, `requestId`,
`httpStatus`, `details`, `retryAfter`): `AuthenticationError`, `PermissionError`,
`InvalidRequestError`, `IdempotencyError`, `RateLimitError`, `CreditsError`, `ChainError`,
`PartnerError`, `ApiError`, `ConnectionError`, `SignatureVerificationError`.

## Pagination

```ts
for await (const inv of cv.invoices.list({ status: "paid", limit: 100 })) { ... }
const page = await cv.invoices.list({ limit: 20 }); // { data, has_more, next_cursor }
```

## Development

```bash
npm install && npm run typecheck && npm run build
COINVELLO_API_KEY=cv_test_x COINVELLO_BASE_URL=http://localhost:4242/v1 npm run example
```
