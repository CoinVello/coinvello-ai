# SDKs

The official SDKs are thin, dependency-light wrappers over the REST
API that handle authentication, idempotency keys, retries, typed errors, pagination and
webhook signature verification. Resource methods map 1:1 to the OpenAPI operations, so the
`openapi.yaml` reference applies to every language.

| Language | Install | Requirements | Registry |
|----------|---------|--------------|----------|
| Node / TypeScript | `npm install @coinvello/sdk` | Node 18+ (global `fetch`), ESM | <https://www.npmjs.com/package/@coinvello/sdk> |
| PHP | `composer require coinvello/sdk` | PHP 8.1+, ext-curl, ext-json | <https://packagist.org/packages/coinvello/sdk> (source <https://github.com/CoinVello/coinvello-php>) |
| Python | `pip install coinvello` | Python 3.9+, no deps (urllib) | <https://pypi.org/project/coinvello/> |

The WooCommerce plugin vendors the PHP SDK. The checkout widget (`npm install @coinvello/checkout`,
or `<script src="https://pay.coinvello.com/sdk/v1/checkout.js">`) does **not** use an SDK: it only
talks to `pay.coinvello.com` with a session id. See [checkout.md](checkout.md).

## Common design

* `Client(apiKey, { baseUrl?, apiVersion?, timeout?, maxRetries? })`
* Resources as properties / methods: `client.invoices.create(...)`, `client.invoices.get(id)`,
  `client.invoices.list({...})`, `.cancel(id)`, `.expire(id)`; same for `payments`, `wallets`,
  `webhooks`, `credits`, `rates`, `conversions`, `offramp`, `checkoutSessions`, `refunds`,
  `events`, `test`.
* Create calls accept an options bag with `idempotencyKey`; if absent one is generated.
* Automatic retry (3x, exponential backoff + jitter) on connection errors, 409
  `idempotency_key_in_progress`, 429 and 5xx.
* Errors: `CoinVelloError` base with `type`, `code`, `message`, `param`, `requestId`,
  `httpStatus`, `details`; subclasses `AuthenticationError`, `PermissionError`,
  `InvalidRequestError`, `IdempotencyError`, `RateLimitError`, `CreditsError`, `ChainError`,
  `PartnerError`, `ApiError`, `ConnectionError`.
* `webhooks.constructEvent(rawBody, signatureHeader, secret, tolerance = 300)` verifies and
  parses; throws `SignatureVerificationError`.
* Lists return `{ data, has_more, next_cursor }` plus an auto-paging iterator.
* All amounts are strings. SDKs never convert to floats.

## Node

```ts
import { CoinVello } from "@coinvello/sdk";

const cv = new CoinVello(process.env.COINVELLO_API_KEY!);

const invoice = await cv.invoices.create({
  amount: "49.99",
  currency: "USD",
  accepted_assets: ["btc:bitcoin", "usdc:polygon"],
  order_id: "WC-10042",
  success_url: "https://shop.example.com/thanks",
}, { idempotencyKey: "order-10042-invoice" });

console.log(invoice.hosted_url);

// webhook (Express with express.raw)
const event = cv.webhooks.constructEvent(req.body, req.get("CoinVello-Signature")!, process.env.CV_WEBHOOK_SECRET!);
```

## PHP

```php
use CoinVello\Sdk\Client;
use CoinVello\Sdk\Webhooks;

$cv = new Client(getenv('COINVELLO_API_KEY'));

$invoice = $cv->invoices()->create([
    'amount' => '49.99',
    'currency' => 'USD',
    'accepted_assets' => ['btc:bitcoin', 'usdc:polygon'],
    'order_id' => 'WC-10042',
    'success_url' => 'https://shop.example.com/thanks',
], ['idempotency_key' => 'order-10042-invoice']);

echo $invoice['hosted_url'];

$event = $cv->webhooks()->constructEvent(file_get_contents('php://input'), $_SERVER['HTTP_COINVELLO_SIGNATURE'], getenv('CV_WEBHOOK_SECRET'));
```

## Python

```python
from coinvello import CoinVello

cv = CoinVello(os.environ["COINVELLO_API_KEY"])

invoice = cv.invoices.create(
    amount="49.99", currency="USD",
    accepted_assets=["btc:bitcoin", "usdc:polygon"],
    order_id="WC-10042", success_url="https://shop.example.com/thanks",
    idempotency_key="order-10042-invoice",
)
print(invoice["hosted_url"])

event = cv.webhooks.construct_event(raw_body, request.headers["CoinVello-Signature"], os.environ["CV_WEBHOOK_SECRET"])
```

## Generating other languages

`openapi.yaml` is OpenAPI 3.1 and lints clean with `@redocly/cli`. It works with
`openapi-generator-cli` (use `--skip-validate-spec` if your generator predates 3.1
`type: [string, 'null']`) and with `oazapfts`/`openapi-typescript` for TS types.

## Testing

Any `cv_test_` key works against the live API (`https://api.coinvello.com/v1`) with testnets and
`POST /test/simulate_payment`; see [testing.md](testing.md). For offline work, point any SDK at the
mock server (`baseUrl: "http://localhost:4242/v1"`, any `cv_test_` key) from
<https://github.com/CoinVello/coinvello-ai/tree/main/api/reference-server>.
