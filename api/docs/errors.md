# Errors

CoinVello uses conventional HTTP status codes and a single error envelope:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "parameter_missing",
    "message": "amount is required.",
    "param": "amount",
    "request_id": "req_8sD9fK2lMn",
    "doc_url": "https://github.com/CoinVello/coinvello-ai/blob/main/api/docs/errors.md",
    "details": {}
  }
}
```

| Field | Always | Meaning |
|-------|--------|---------|
| `type` | yes | Broad category (below). Branch on this first. |
| `code` | yes | Stable machine-readable code. Branch on this second. |
| `message` | yes | Human-readable, English, safe to log. Not for end users. |
| `param` | no | JSON path of the offending field (`accepted_assets[1]`). |
| `request_id` | yes | Quote when contacting support. Also in the `Request-Id` header. |
| `doc_url` | no | Link to this page. |
| `details` | no | Extra structured context for some codes. |

Messages may change; `type` and `code` will not change within an API version.

## HTTP status codes

| Status | Meaning |
|--------|---------|
| 200 | OK |
| 201 | Created |
| 400 | Malformed request, missing or invalid parameter |
| 401 | Missing or invalid API key |
| 402 | Insufficient processing credits |
| 403 | Key lacks permission (scope, mode, admin-only) |
| 404 | Object not found (or belongs to the other mode) |
| 409 | Conflict - invalid state transition or idempotency reuse |
| 422 | Well-formed but semantically invalid (asset not enabled, bad xpub...) |
| 429 | Rate limited - see `Retry-After` |
| 500, 502, 503, 504 | CoinVello problem. Safe to retry with the same `Idempotency-Key`. |

## Error types

| `type` | Status | Description |
|--------|--------|-------------|
| `invalid_request_error` | 400 / 404 / 409 / 422 | Problem with your request |
| `authentication_error` | 401 | Bad or missing key |
| `permission_error` | 403 | Key exists but may not do this |
| `idempotency_error` | 409 | Idempotency key misuse |
| `rate_limit_error` | 429 | Too many requests |
| `credits_error` | 402 | Not enough credits |
| `card_error` | 402 / 422 | A card purchase of credits was declined or is not possible |
| `chain_error` | 422 / 502 | On-chain problem (broadcast rejected, node unavailable) |
| `partner_error` | 502 | Off-ramp / liquidity partner returned an error |
| `api_error` | 500+ | Internal error |

## Error codes

### invalid_request_error
| `code` | Status | When |
|--------|--------|------|
| `parameter_missing` | 400 | Required field absent |
| `parameter_invalid` | 400 | Wrong type, bad format, out of range |
| `parameter_unknown` | 400 | Unknown field (strict parsing on create) |
| `reset_token_invalid` | 400 | Password reset token is unknown, already used, superseded or older than 30 minutes. Request a new link |
| `amount_too_small` | 400 | Below `min_amount` for an accepted asset |
| `amount_too_large` | 400 | Above per-invoice limit |
| `currency_unsupported` | 400 | Not a supported fiat or asset id |
| `resource_missing` | 404 | No object with that id in this mode |
| `invalid_state` | 409 | Action not allowed in the object's current status |
| `asset_not_enabled` | 422 | No enabled wallet for an accepted asset |
| `chains_not_compatible` | 422 | `chains` contains a non-EVM chain (`details.chain`) or was used with `type: xpub` |
| `asset_coming_soon` | 422 | The asset or chain is listed in `GET /assets` with `status: coming_soon` and cannot be used yet |
| `xpub_required` | 422 | Bitcoin wallets must be registered as an xpub (a fresh address per invoice) |
| `xpub_invalid` | 422 | Not a valid extended public key for the chain |
| `xprv_rejected` | 422 | You sent a private key. It was discarded. Rotate it. |
| `address_invalid` | 422 | Address fails format/checksum for the chain, belongs to the other network (testnet in live mode or vice versa), or is the zero/burn address, a precompile or a token contract. `param` names the field |
| `derivation_path_invalid` | 422 | Not of the form `m/84'/0'/0'` |
| `signature_invalid` | 422 | Optional wallet verification: signature does not match |
| `challenge_expired` | 422 | Verification challenge older than 15 minutes |
| `quote_expired` | 409 | Rate / conversion / off-ramp quote no longer valid |
| `rate_lock_expired` | 409 | Lock expired before the invoice was created |
| `rate_lock_used` | 409 | Lock already attached to another invoice |
| `destination_invalid` | 422 | Refund / conversion destination fails validation |
| `destination_same_as_source` | 422 | Refund destination equals the receiving address |
| `metadata_too_large` | 400 | More than 50 keys or value over 500 chars |
| `suspicious_input` | 400 | A field carries an injection payload (template expression such as `{{7*7}}`, PHP tag, SQL or shell injection, path traversal, script markup). `param` names the field. Three within an hour block access (`access_temporarily_blocked`) |
| `url_insecure` | 422 | Webhook/success URL must be HTTPS in live mode |
| `test_mode_only` | 403 | Endpoint requires a `cv_test_` key |
| `live_mode_only` | 403 | Endpoint requires a `cv_live_` key |
| `pay_as_you_go_unavailable` | 422 | `billing_plan: pay_as_you_go` is not open to this account (reserved; pay as you go is open to every account) |
| `nothing_to_sweep` | 409 | The receiver has no unswept balance (`POST /receivers/{id}/sweep_transaction`, `/test/simulate_sweep`) |

### authentication_error
| `code` | When |
|--------|------|
| `api_key_missing` | No `Authorization` header |
| `api_key_invalid` | Unknown or malformed key |
| `api_key_revoked` | Key was revoked |
| `api_key_expired` | Key past its expiry (restricted keys can expire) |

### permission_error
| `code` | When |
|--------|------|
| `insufficient_scope` | Restricted key lacks the scope |
| `admin_only` | Merchant key used on `/admin` |
| `merchant_only` | Admin key used on a merchant endpoint |
| `merchant_suspended` | Account suspended; read endpoints still work |
| `ip_not_allowed` | Key has an IP allowlist |
| `access_temporarily_blocked` | Repeated `suspicious_input` requests: the account and the IP are blocked for an hour (a day on a repeat), or staff blocked the IP or the account. Honour `Retry-After`; write to support@coinvello.com if it is a mistake |
| `access_blocked` | Staff blocked the IP or the account until further notice. Write to support@coinvello.com if it is a mistake |
| `email_blocked` | Support Desk: staff blocked this email address or its domain from opening tickets |

### idempotency_error
| `code` | When |
|--------|------|
| `idempotency_key_reused` | Same key, different body |
| `idempotency_key_in_progress` | Original request still executing - retry shortly |
| `idempotency_key_too_long` | Over 255 chars |

### credits_error
| `code` | When |
|--------|------|
| `insufficient_credits` (402) | The `available` credits cannot cover this invoice's estimated fee (or this operation) and the account did not switch to pay as you go (`auto_switch_to_pay_as_you_go` off, or pay as you go not open to it). `details: { available, required, bundles_url }`. The balance never goes below zero; buy credits or switch to pay as you go |
| `purchase_underpaid` | Credit purchase confirmed below the price |

### card_error
| `code` | When |
|--------|------|
| `card_declined` | 402. The card was declined; a `failed` purchase is recorded and `details.purchase_id` names it |
| `card_limit_exceeded` | 422. Card purchases would exceed the 24-hour limit; `details.limit_usd` and `details.used_usd` are set |
| `card_locked` | 422. Card purchases are paused for 24 hours after repeated declines |
| `card_payments_unavailable` | 422. Card payments are not configured for this mode |
| `payment_method_required` | 422. No saved card (purchase or automatic top-up) |
| `payment_method_limit` | 422. At most 3 cards can be saved |
| `processor_error` | 422. Square returned an error; `details.processor_code` is set |

### chain_error
| `code` | Status | When |
|--------|--------|------|
| `broadcast_rejected` | 422 | Node rejected your signed transaction (`details.node_message`) |
| `transaction_mismatch` | 422 | Signed tx does not match the unsigned tx CoinVello prepared |
| `insufficient_funds` | 422 | Source wallet cannot cover amount + fee |
| `nonce_too_low` | 422 | EVM nonce already used - re-create the conversion/refund |
| `node_unavailable` | 502 | Temporary RPC outage; retry |

### partner_error
| `code` | When |
|--------|------|
| `partner_unavailable` | Partner API down |
| `partner_rejected` | Partner declined (`details.partner_message`) |
| `partner_auth_revoked` | Merchant revoked the connection at the partner; reconnect |
| `partner_verification_required` | Partner requires the merchant to complete verification **on the partner's site** |

### rate_limit_error
| `code` | When |
|--------|------|
| `rate_limited` | Too many requests; honour `Retry-After` |

### api_error
| `code` | When |
|--------|------|
| `internal_error` | Something broke on our side. Retry with the same `Idempotency-Key`. |

## Handling errors in code

```js
try {
  await client.invoices.create({...});
} catch (e) {
  if (e instanceof CoinVelloError) {
    switch (e.code) {
      case "insufficient_credits": notifyOps(e.details); break;
      case "asset_not_enabled": disableAssetInSettings(e.param); break;
      case "rate_limited": await sleep(e.retryAfter * 1000); return retry();
      default: log(e.requestId, e.type, e.code, e.message);
    }
  }
}
```

The SDKs raise typed exceptions (`AuthenticationError`, `InvalidRequestError`,
`RateLimitError`, `CreditsError`, ...) that expose `type`, `code`, `param`, `requestId`,
`details` and `httpStatus`.
