# Verifying CoinVello webhooks

## The scheme (authoritative)

```
CoinVello-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>[,v1=<hex HMAC-SHA256>]
```

1. `t` is the Unix timestamp (seconds) at signing time.
2. Signed payload = ASCII `t` + literal `.` + the **raw request body bytes** exactly as sent.
3. `v1 = hex(HMAC_SHA256(key = endpoint secret as UTF-8 **including the `whsec_` prefix**, message = signed payload))`.
4. During secret rotation there are two `v1=` pairs; the signature is valid if **any** matches.

Verification order:

1. Get the raw body before any JSON parsing or body-parser middleware (re-serialised JSON breaks the HMAC).
2. Parse the header; reject if `t` is missing or `|now - t| > 300` s.
3. Compute the expected HMAC; compare against each `v1` with a constant-time compare.
4. Dedupe on `event.id` (keep ids >= 3 days); retries reuse the id with a fresh `t` and signature.
5. Parse JSON, act on `event.type` and `event.data.object.status`. Respond 2xx within 10 s.

Other headers available: `CoinVello-Event-Id`, `CoinVello-Event-Type`, `CoinVello-Webhook-Id`,
`CoinVello-Delivery-Id`, `CoinVello-Delivery-Attempt`. They are informational; only the signature proves origin.

## Raw-body gotchas per framework

| Framework | How to get the raw body |
|-----------|------------------------|
| Express | `express.raw({ type: "application/json" })` on the webhook route only; `req.body` is a Buffer |
| Next.js app router | `await req.text()` in the route handler (do not call `req.json()` first) |
| Next.js pages router | `export const config = { api: { bodyParser: false } }` and read the stream |
| Fastify | `addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => done(null, body))` |
| FastAPI / Starlette | `await request.body()` |
| Flask | `request.get_data()` |
| Django | `request.body` (+ `@csrf_exempt`) |
| Laravel | `$request->getContent()`; exclude the route from `VerifyCsrfToken` |
| Plain PHP / WordPress | `file_get_contents('php://input')`, never `$_POST` |
| Rails | `request.raw_post`; `skip_before_action :verify_authenticity_token` |
| Sinatra | `request.body.read` |
| Go net/http | `io.ReadAll(r.Body)` |
| ASP.NET Core | `EnableBuffering()` + `StreamReader(Request.Body).ReadToEndAsync()` |
| Spring | `@RequestBody String raw` (String, not a bean) |

## Verifiers

### Node

```js
import crypto from "node:crypto";
export function verifyCoinVelloSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header) throw new Error("missing CoinVello-Signature");
  let t = 0; const sigs = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("="); const v = rest.join("=");
    if (k === "t") t = Number(v);
    if (k === "v1") sigs.push(v);
  }
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new Error("timestamp outside tolerance");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(body).digest();
  const ok = sigs.some((s) => { const b = Buffer.from(s, "hex"); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  if (!ok) throw new Error("signature mismatch");
  return JSON.parse(body.toString("utf8"));
}
```

### Python

```python
import hmac, hashlib, json, time
def verify_coinvello_signature(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> dict:
    t, sigs = 0, []
    for part in (header or "").split(","):
        k, _, v = part.strip().partition("=")
        if k == "t": t = int(v)
        elif k == "v1": sigs.append(v)
    if not t or abs(time.time() - t) > tolerance:
        raise ValueError("timestamp outside tolerance")
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, s) for s in sigs):
        raise ValueError("signature mismatch")
    return json.loads(raw_body)
```

### PHP

```php
function coinvello_verify(string $raw, string $header, string $secret, int $tolerance = 300): array {
    $t = 0; $sigs = [];
    foreach (explode(',', $header) as $pair) {
        $kv = explode('=', trim($pair), 2);
        if (count($kv) !== 2) continue;
        if ($kv[0] === 't')  { $t = (int) $kv[1]; }
        if ($kv[0] === 'v1') { $sigs[] = $kv[1]; }
    }
    if ($t === 0 || abs(time() - $t) > $tolerance) throw new RuntimeException('timestamp outside tolerance');
    $expected = hash_hmac('sha256', $t . '.' . $raw, $secret);
    foreach ($sigs as $sig) { if (hash_equals($expected, $sig)) return json_decode($raw, true, 512, JSON_THROW_ON_ERROR); }
    throw new RuntimeException('signature mismatch');
}
```

### Ruby

```ruby
require "openssl"; require "json"
def verify_coinvello_signature(raw_body, header, secret, tolerance: 300)
  t = 0; sigs = []
  header.to_s.split(",").each do |part|
    k, v = part.strip.split("=", 2)
    t = v.to_i if k == "t"
    sigs << v if k == "v1"
  end
  raise "timestamp outside tolerance" if t.zero? || (Time.now.to_i - t).abs > tolerance
  expected = OpenSSL::HMAC.hexdigest("SHA256", secret, "#{t}.#{raw_body}")
  ok = sigs.any? { |s| s.bytesize == expected.bytesize && OpenSSL.fixed_length_secure_compare(s, expected) }
  raise "signature mismatch" unless ok
  JSON.parse(raw_body)
end
```

### Go

```go
func verifyCoinVelloSignature(rawBody []byte, header, secret string, tolerance time.Duration) (map[string]any, error) {
	var t int64
	var sigs []string
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 { continue }
		switch kv[0] {
		case "t": t, _ = strconv.ParseInt(kv[1], 10, 64)
		case "v1": sigs = append(sigs, kv[1])
		}
	}
	if t == 0 || math.Abs(float64(time.Now().Unix()-t)) > tolerance.Seconds() {
		return nil, errors.New("timestamp outside tolerance")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(t, 10) + "."))
	mac.Write(rawBody)
	expected := mac.Sum(nil)
	for _, s := range sigs {
		if b, err := hex.DecodeString(s); err == nil && hmac.Equal(b, expected) {
			var ev map[string]any
			return ev, json.Unmarshal(rawBody, &ev)
		}
	}
	return nil, errors.New("signature mismatch")
}
```

## Self-test

```
secret  = whsec_test
t       = 1760000000
body    = {"id":"evt_1","type":"ping"}
signed  = 1760000000.{"id":"evt_1","type":"ping"}
```

Compute `v1` with your implementation and assert: (a) header `t=1760000000,v1=<v1>` verifies when the
clock is faked to 1760000000; (b) appending a single space to the body fails; (c) `t=1759990000`
fails on tolerance; (d) `t=...,v1=deadbeef,v1=<v1>` verifies (rotation). The MCP tool
`verify_webhook_signature` (with `ignore_timestamp: true`) gives you the expected value to compare against.

For an end-to-end test against the local mock: create a webhook pointing at your handler, create an
invoice, `POST /test/simulate_payment` with enough confirmations; the mock signs and delivers
synchronously, so your handler has run before the simulate call returns.
