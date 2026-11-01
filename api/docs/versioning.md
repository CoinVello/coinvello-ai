# Versioning

The API is versioned by **date**. The current version is `2026-10-01`.

Your account is pinned to the version that was current when you created it. Every response
includes the version it was rendered with:

```
CoinVello-Version: 2026-10-01
```

## Overriding per request

```
CoinVello-Version: 2026-10-01
```

Send this header to render a request/response with a specific version regardless of the
account default. Useful for testing an upgrade before the account default moves to the new version.

## Webhook payloads

Each webhook endpoint has its own `api_version` (set at creation, changeable with
`PATCH /webhooks/{id}`). Event payloads are rendered with the endpoint's version, so you
can upgrade your webhook consumer and your API client independently. `Event.api_version`
tells you which version a payload used.

## What is a breaking change

We release a new dated version only for changes like:

* removing or renaming a field or endpoint
* changing a field's type or format
* changing the meaning of an existing enum value
* changing error `type`/`code` for an existing situation
* tightening validation on an existing field

These are **not** breaking and can appear at any time inside a version:

* new endpoints, new optional request fields, new response fields
* new enum values on `status`, `type`, `code`, `chain`, asset ids, event types
* new webhook event types (you only receive the ones you subscribe to, unless you used `*`)
* longer ids, new id prefixes for new objects

Write parsers that ignore unknown fields and treat unknown enum values as "other".

## Lifecycle

* Each version is supported for at least **24 months** after its successor ships.
* Deprecations are announced in the release notes at <https://github.com/CoinVello/coinvello-ai/releases>
  and by email to the account's technical contact.
* The OpenAPI document in this repository (`api/openapi.yaml`) tracks the current version;
  `info.version` is the version date.

## SDK versions

SDKs follow semver independently of the API date. Each SDK release pins a `CoinVello-Version`
it was built against and sends it by default; override with the client option `apiVersion`.
