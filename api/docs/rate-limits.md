# Rate limits

Limits are applied per API key using a sliding window.

| Scope | Live | Test |
|-------|------|------|
| Default (all endpoints) | 100 requests / second, burst 200 | 25 requests / second |
| `POST /invoices`, `POST /checkout-sessions` | 50 / second | 10 / second |
| `GET /rates`, `POST /rates/quotes` | 20 / second | 10 / second |
| `POST /test/simulate_payment` | - | 5 / second |
| `/admin/*` | 20 / second per staff key | - |

Every response carries:

```
RateLimit-Limit: 100
RateLimit-Remaining: 97
RateLimit-Reset: 1760000061
```

When you exceed a limit you get `429 rate_limit_error / rate_limited` and a `Retry-After`
header in seconds. Back off for at least that long; the SDKs do this automatically with
jitter and up to 3 retries.

## Avoid polling

Do not poll `GET /invoices/{id}` every second from a checkout page. Instead:

* Fulfil orders from **webhooks** (`invoice.paid`), which arrive within seconds of the
  confirming block.
* For a live status display, use the hosted page (which uses server push) or poll at most
  every 5-10 seconds while the invoice is `new`/`pending`/`confirming`, then stop.
* Use `GET /events?created_gte=` for catch-up after downtime instead of listing every
  resource.

## Need more?

Limits are generous for e-commerce. If you run a high-volume platform, email
support@coinvello.com with your key prefix and expected rate; higher limits are
available without any identity paperwork.
