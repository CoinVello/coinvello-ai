# Verification checklist

Run through every line before telling the user the integration is done. Items marked (mock) can be
executed against `http://localhost:4242/v1` with no account; the rest need a `cv_test_` key.

## Configuration

- [ ] `COINVELLO_API_KEY` is read from the environment on the server only; grep the client bundle / templates for `cv_test_` and `cv_live_` and find nothing.
- [ ] `COINVELLO_WEBHOOK_SECRET` is read from the environment; the webhook was created with `POST /webhooks` (or the dashboard) and its `secret` stored.
- [ ] `.env.example` (or the project's equivalent) lists both variables with placeholder values.
- [ ] Amounts are built as decimal strings (`"49.99"`), not floats or integers of cents.

## Start-payment route (mock)

- [ ] Creating a session returns `201` with `object: "checkout_session"`, `url` starting with `https://pay.coinvello.com/c/cs_`, and `invoice_id` starting with `inv_`.
- [ ] `Idempotency-Key` is sent and stable per order; calling the route twice for the same order returns the same session id.
- [ ] `session.id` and `session.invoice_id` are persisted on the order.
- [ ] The response to the browser is a 303 redirect to `session.url` (or the session id is handed to the widget).
- [ ] `success_url` / `cancel_url` point at real pages in the app; the success page shows "confirming" and does not mark the order paid by itself.

## Webhook route (mock)

- [ ] The route reads the raw body (see `webhook-verification.md` for the framework-specific way) and is excluded from CSRF protection.
- [ ] A real delivery from `POST /test/simulate_payment` (or the mock's synchronous delivery) is accepted with 200 and the order becomes paid on `invoice.paid`.
- [ ] A delivery with one extra byte in the body returns 400.
- [ ] A delivery whose `t` is 1000 s old returns 400.
- [ ] A header with two `v1=` values where only the second matches is accepted (rotation).
- [ ] Re-delivering the same `event.id` is a no-op and still returns 200.
- [ ] `invoice.underpaid`, `invoice.overpaid`, `invoice.expired` flag the order (not fulfil it); unknown event types return 200.
- [ ] The handler responds in well under 10 s; anything slow (emails, fulfilment APIs) is queued.

## Happy path end to end (mock or test key)

```
1. POST /webhooks {url: <app>/webhooks/coinvello, events: ["*"]}            -> secret stored
2. Trigger the app's start-payment route for a test order                   -> redirected to pay.coinvello.com/c/cs_...
3. POST /test/simulate_payment {invoice_id, asset, confirmations: 0}        -> order shows "payment detected"
4. POST /test/simulate_payment {invoice_id, asset, confirmations: 99, same tx_hash} -> order paid
5. GET /invoices/{invoice_id}                                               -> status "paid", paid.amount_received set
6. GET /webhooks/{id}/deliveries                                            -> every attempt 2xx
```

Underpaid path: step 3 with `amount` at 90% of `payment_options[].amount` and confirmations 99 ->
order flagged `underpaid`, not fulfilled.

## Reconciliation and operations

- [ ] An admin or cron path can call `GET /invoices/{id}` (or list by `order_id`) to resync a stuck order.
- [ ] `402 insufficient_credits` is surfaced to the merchant with a link to buy credits, not swallowed.
- [ ] Logs include `error.request_id` for failed API calls.
- [ ] `GET /credits/balance` is visible somewhere the merchant will see it (or `credits.low` webhook is handled).

## Before go-live

- [ ] Account email confirmed (live keys and live writes return `403 email_unverified` until it is).
- [ ] Live wallet(s) registered and enabled for every chain in `accepted_assets` (verification optional; xpub `first_address` checked).
- [ ] Credits purchased (`GET /credits/balance` shows `available > 0` on the live key), or the account is on pay as you go (`GET /account` `billing_plan`).
- [ ] Live webhook endpoint created over HTTPS with the live key; new `whsec_` stored in production secrets.
- [ ] `cv_test_` replaced with `cv_live_` in production only; test key stays in development.
- [ ] One real small payment made and refunded/kept as a sanity check (optional but recommended).

## Statements to double-check in any docs or UI copy you wrote

- "Funds go directly to your wallet; CoinVello never holds them."
- "No KYC or KYB; sign up with an email."
- "Fees are prepaid processing credits bought in crypto or by card, from about 0.30% down to under 0.10% effective, or 0.4% pay as you go split on-chain (not on Bitcoin)."
- Supported networks list matches `GET /assets`.
