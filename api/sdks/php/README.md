# coinvello/sdk (PHP)

PSR-4 client for the [CoinVello API](../../openapi.yaml). PHP 8.1+, `ext-curl`, `ext-json`.
**No Guzzle** or other dependencies, so WordPress / WooCommerce plugins can vendor it safely.

```bash
composer config repositories.coinvello composer https://coinvello.com/composer
composer config repositories.coinvello composer https://coinvello.com/composer && composer require coinvello/sdk
```

```php
use CoinVello\Sdk\Client;

$cv = new Client(getenv('COINVELLO_API_KEY')); // cv_live_... or cv_test_...

$invoice = $cv->invoices()->create([
    'amount'          => '49.99',
    'currency'        => 'USD',
    'accepted_assets' => ['btc:bitcoin', 'usdt:tron'],
    'order_id'        => 'WC-10042',
    'success_url'     => 'https://shop.example.com/thanks',
], ['idempotency_key' => 'order-10042-invoice']);

echo $invoice['hosted_url'];
```

Responses are plain associative arrays mirroring the JSON. Amounts are strings; do not cast
to float.

## Resources

`$cv->invoices()` (create, get, list, update, cancel, expire, listPayments) ·
`payments()` · `wallets()` (create, createVerification, verify, listAddresses) ·
`webhooks()` (CRUD, rotateSecret, test, listDeliveries, **constructEvent**) ·
`credits()` (balance, bundles, purchase, getPurchase, listPurchases, ledger) ·
`rates()` · `conversions()` · `offramp()` · `checkoutSessions()` · `refunds()` · `events()` ·
`records()` (list, retrieve, summary) · `exports()` (create, list, retrieve, delete, download) ·
`test()->simulatePayment()`.

## Records and exports

```php
$export = $cv->exports()->create(['dataset' => 'records', 'format' => 'xlsx',
    'period' => ['start' => '2026-07-01', 'end' => '2026-10-01']], ['idempotency_key' => 'q3-2026-records']);
while (in_array($export['status'], ['queued', 'processing'], true)) { sleep(2); $export = $cv->exports()->retrieve($export['id']); }
if ($export['status'] === 'ready') { file_put_contents('q3-records.xlsx', $cv->exports()->download($export['id'])); }
```

Statuses are `queued`, `processing`, `ready`, `failed`, `expired`. With a test key, rows from
`/test/simulate_*` only appear when you add `'include_simulated' => true` (to `records()->list`, `summary` and `exports()->create`). `records()->list()` pages like any list; invoices
and checkout sessions accept `tax: {amount, rate, label, jurisdiction}` (`amount` a decimal string already
included in the invoice amount).

## Webhooks

```php
use CoinVello\Sdk\Webhooks;
use CoinVello\Sdk\Exception\SignatureVerificationException;

$raw    = file_get_contents('php://input');          // raw body, never $_POST
$header = $_SERVER['HTTP_COINVELLO_SIGNATURE'] ?? '';

try {
    $event = Webhooks::constructEvent($raw, $header, getenv('CV_WEBHOOK_SECRET'));
} catch (SignatureVerificationException $e) {
    http_response_code(400);
    exit($e->getMessage());
}

if ($event['type'] === 'invoice.paid') {
    // idempotent on $event['id']
    mark_order_paid($event['data']['object']['order_id']);
}
http_response_code(200);
```

`Webhooks::constructEvent($raw, $header, $secret, $tolerance = 300)` checks the 5-minute
window and compares every `v1=` signature with `hash_equals` (rotation-safe).
`Webhooks::generateHeader($body, $secret)` builds a header for tests.

In WordPress, read the raw body with `file_get_contents('php://input')` inside your REST
route callback or `WC_API` handler before anything else touches it.

## Options

```php
new Client($key, [
    'base_url'    => 'http://localhost:4242/v1', // reference-server for local tests
    'api_version' => '2026-10-01',
    'timeout'     => 30,
    'max_retries' => 3,   // connection errors, 429, 5xx, 409 idempotency_key_in_progress
    'user_agent'  => 'coinvello-woocommerce/1.0.0',
]);
```

## Errors

`CoinVello\Sdk\Exception\ApiErrorException` (and subclasses `AuthenticationException`,
`PermissionException`, `InvalidRequestException`, `IdempotencyException`, `RateLimitException`,
`CreditsException`, `ChainException`, `PartnerException`, `ApiException`) expose
`getType()`, `getErrorCode()`, `getParam()`, `getRequestId()`, `getHttpStatus()`,
`getRetryAfter()`, `getDetails()`. Network failures throw `ConnectionException`.

## Pagination

```php
$page = $cv->invoices()->list(['status' => 'paid', 'limit' => 100]);
$page->data(); $page->hasMore(); $page->nextCursor(); $page->nextPage();
foreach ($page->autoPagingIterator() as $invoice) { ... }
```

## Development

```bash
composer install
COINVELLO_API_KEY=cv_test_x COINVELLO_BASE_URL=http://localhost:4242/v1 composer example
```
