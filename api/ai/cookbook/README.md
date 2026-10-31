# CoinVello cookbook

Single-file, runnable recipes. Each checkout recipe implements the same two things (`export-records-to-excel.ts` is the bookkeeping exception: it creates an Excel export of a quarter of records, polls until `ready`, downloads it and verifies `file.sha256`):

1. **Start payment**: create a checkout session (`POST /checkout-sessions`) with a stable
   `Idempotency-Key` and redirect the customer to `session.url`.
2. **Webhook**: read the raw body, verify `CoinVello-Signature` (HMAC-SHA256 over `"<t>.<raw body>"`
   with the `whsec_` secret, 300 s tolerance, constant-time compare, any `v1` may match), dedupe on
   `event.id`, fulfil on `invoice.paid`.

Every file begins with a header comment an AI assistant can follow as instructions (env vars, how to
run, how to test against the mock). Replace the `TODO` persistence stubs with your database.

| File | Stack | Run |
|------|-------|-----|
| `curl-60-seconds.sh` | bash + curl | `COINVELLO_API_KEY=cv_test_... ./curl-60-seconds.sh` |
| `nextjs-route-handlers.ts` | Next.js 14/15 app router | copy the two handlers into `app/api/...` |
| `express.mjs` | Node 18+, Express 4/5 | `node express.mjs` |
| `fastapi_app.py` | Python 3.10+, FastAPI, httpx | `uvicorn fastapi_app:app` |
| `flask_app.py` | Flask, requests | `flask --app flask_app run` |
| `django_views.py` | Django 4/5 | add to `urls.py` |
| `LaravelCoinVelloController.php` | Laravel 10/11 | register two routes |
| `sinatra_app.rb` | Ruby 3, Sinatra | `ruby sinatra_app.rb` |
| `go_main.go` | Go 1.21+, net/http | `go run go_main.go` |
| `export-records-to-excel.ts` | Node 18+, TypeScript (no payments; bookkeeping) | `npx tsx export-records-to-excel.ts 2026-07-01 2026-10-01` |

Environment for all of them:

```
COINVELLO_API_KEY=cv_test_...          # server-side only
COINVELLO_WEBHOOK_SECRET=whsec_...     # from POST /webhooks (shown once)
COINVELLO_API_BASE=https://api.coinvello.com/v1   # or http://localhost:4242/v1 for the mock
APP_URL=http://localhost:3000          # used to build success/cancel URLs
```

Test any recipe without an account:

```bash
cd api/reference-server && npm install && npm start            # mock on :4242
# register your local handler as the webhook target and copy the secret
curl -s localhost:4242/v1/webhooks -H "Authorization: Bearer cv_test_x" -H "Content-Type: application/json" \
  -d '{"url":"http://localhost:3000/webhooks/coinvello","events":["*"]}'
# start the recipe, open http://localhost:3000/pay/ORDER-1 (or POST to it), then pay the invoice:
curl -s localhost:4242/v1/test/simulate_payment -H "Authorization: Bearer cv_test_x" -H "Content-Type: application/json" \
  -d '{"invoice_id":"inv_...","confirmations":99}'
```

The mock delivers the signed `invoice.paid` webhook to your handler synchronously.
