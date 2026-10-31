# Postman / Insomnia / Bruno

`CoinVello.postman_collection.json` is a Postman v2.1 collection covering invoices, checkout sessions,
payments, wallets, webhooks, credits, records and exports, rates, assets and events, with a `Quickstart` folder that runs
top to bottom (webhook -> checkout session -> simulate payment -> paid invoice -> verified delivery).

## Postman

1. Import the file (File -> Import).
2. Set collection variables: `api_key` = your `cv_test_...` key; `base_url` stays
   `https://api.coinvello.com/v1`, or `http://localhost:4242/v1` for the reference mock.
3. Run the `Quickstart` folder with the Collection Runner. Request 9 (`/webhook-sink`) only works
   against the mock; with the real API point request 2 at your own handler and inspect
   `GET /webhooks/{id}/deliveries` instead.

A pre-request script adds a random `Idempotency-Key` to every POST that lacks one. Bearer auth is set
at collection level from `{{api_key}}`.

Publishing: create a public Postman workspace "CoinVello" and publish this collection with the
documentation tab enabled so it shows up in Postman search for "crypto payments".

## Insomnia

Insomnia imports Postman v2.1 collections directly (Create -> Import -> From File). Variables become
environment variables; the pre-request script is ignored, so add an `Idempotency-Key` header manually
on POSTs or let the server generate one (the API accepts requests without it; replays simply are not deduped).

## Bruno

Bruno imports Postman collections (Import Collection -> Postman Collection). Collection variables map
to a Bruno environment; the `test` scripts port with minimal edits (`pm.test` -> `test`,
`pm.response.json()` -> `res.getBody()`, `pm.collectionVariables.set` -> `bru.setVar`). Store the
resulting folder in the repo if you want a git-friendly copy.

## Generating a client instead

The OpenAPI spec at `../../openapi.yaml` (served at https://coinvello.com/.well-known/openapi.yaml)
imports into Postman, Insomnia, Bruno, Hoppscotch and every OpenAPI generator. Official SDKs for
Node, PHP and Python live in `../../sdks/`.
