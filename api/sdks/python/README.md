# coinvello (Python)

Dependency-free client for the [CoinVello API](../../openapi.yaml). Python 3.9+, stdlib
`urllib` only.

```bash
pip install https://coinvello.com/downloads/sdk/coinvello-0.1.0-py3-none-any.whl
```

```python
from coinvello import CoinVello

cv = CoinVello(os.environ["COINVELLO_API_KEY"])  # cv_live_... or cv_test_...

invoice = cv.invoices.create(
    amount="49.99",
    currency="USD",
    accepted_assets=["btc:bitcoin", "usdt:tron"],
    order_id="WC-10042",
    success_url="https://shop.example.com/thanks",
    idempotency_key="order-10042-invoice",
)
print(invoice["hosted_url"])
```

Responses are plain dicts mirroring the JSON. Amounts are strings - use `decimal.Decimal`,
never `float`.

## Resources

`cv.invoices` (create, get, list, update, cancel, expire, list_payments) · `cv.payments` ·
`cv.wallets` (create, create_verification, verify, list_addresses) · `cv.webhooks` (CRUD,
rotate_secret, test, list_deliveries, **construct_event**) · `cv.credits` (balance, bundles,
purchase, get_purchase, list_purchases, ledger) · `cv.rates` · `cv.conversions` · `cv.offramp` ·
`cv.checkout_sessions` · `cv.refunds` · `cv.events` · `cv.records` (list, retrieve, summary) ·
`cv.exports` (create, list, retrieve, delete, download) · `cv.assets` · `cv.test.simulate_payment`.

## Records and exports

Add `tax={"amount": "7.98", "rate": "0.19", "label": "VAT 19%", "jurisdiction": "DE"}` to
`cv.invoices.create(...)` (a decimal string, already included in `amount`) and every payment lands in
your book of record. Export last quarter to Excel:

```python
exp = cv.exports.create(dataset="records", format="xlsx", period={"start": "2026-07-01", "end": "2026-10-01"},
                        idempotency_key="records-2026-q3")
while exp["status"] in ("queued", "processing"):  # ends as ready, failed or expired
    time.sleep(2)
    exp = cv.exports.retrieve(exp["id"])
if exp["status"] == "ready":
    open(exp["file"]["name"], "wb").write(cv.exports.download(exp["id"]))  # bytes
```

With a test key, rows from `/test/simulate_*` only appear when you pass `include_simulated=True` (to `records.list`, `records.summary` and `exports.create`).
`cv.records.summary(period_start="2026-01-01", period_end="2027-01-01", group_by="month")` returns the
totals; `period_end` is exclusive.

## Webhooks

```python
from coinvello import Webhooks, SignatureVerificationError

@app.post("/webhooks/coinvello")
def hook():
    try:
        event = Webhooks.construct_event(request.get_data(), request.headers.get("CoinVello-Signature"), SECRET)
    except SignatureVerificationError as e:
        abort(400, str(e))
    if event["type"] == "invoice.paid":
        mark_paid(event["data"]["object"]["order_id"])   # idempotent on event["id"]
    return "", 200
```

`construct_event(raw_body, header, secret, tolerance=300)` enforces the 5-minute window and
compares each `v1=` HMAC-SHA256 with `hmac.compare_digest` (rotation-safe).
`Webhooks.sign_payload(body, secret)` builds a header for tests.

## Options

```python
CoinVello(key, base_url="http://localhost:4242/v1", api_version="2026-10-01", timeout=30, max_retries=3)
```

## Errors

`CoinVelloError` (`type`, `code`, `param`, `request_id`, `http_status`, `details`,
`retry_after`) and subclasses `AuthenticationError`, `PermissionError`, `InvalidRequestError`,
`IdempotencyError`, `RateLimitError`, `CreditsError`, `ChainError`, `PartnerError`, `ApiError`,
`ConnectionError`, `SignatureVerificationError`.

## Pagination

```python
page = cv.invoices.list(status="paid", limit=100)   # dict with data / has_more / next_cursor
for inv in page.auto_paging_iter(): ...
```

## Development

```bash
COINVELLO_API_KEY=cv_test_x COINVELLO_BASE_URL=http://localhost:4242/v1 python examples/create_invoice.py
```
