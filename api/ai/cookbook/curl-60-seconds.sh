#!/usr/bin/env bash
# CoinVello in 60 seconds with curl only.
#
# What this does: registers a webhook, creates a hosted checkout session, simulates the customer paying
# it (test mode), shows the invoice flipping to "paid", and verifies the signature of the delivered
# webhook with openssl. Nothing here touches mainnet.
#
# Needs: bash, curl, openssl, and either
#   COINVELLO_API_KEY=cv_test_...   (real test mode; webhook URL below must be reachable from the internet), or
#   the local mock: cd api/reference-server && npm install && npm start  then
#   COINVELLO_API_BASE=http://localhost:4242/v1 COINVELLO_API_KEY=cv_test_local ./curl-60-seconds.sh
#
# Conventions worth remembering: amounts are decimal strings, asset ids are <asset>:<chain>,
# every POST carries an Idempotency-Key, errors come back as {"error":{"type","code","message"}}.
set -euo pipefail

B="${COINVELLO_API_BASE:-https://api.coinvello.com/v1}"
K="Authorization: Bearer ${COINVELLO_API_KEY:?set COINVELLO_API_KEY to a cv_test_ key}"
J="Content-Type: application/json"
# A webhook target. The mock ships a sink at $B/webhook-sink; against the real API use your own HTTPS URL.
HOOK_URL="${WEBHOOK_URL:-$B/webhook-sink}"

json() { grep -o "\"$1\":\"[^\"]*\"" | head -n1 | cut -d'"' -f4; }   # first occurrence of a string field, no jq needed

echo "1) webhook endpoint -> $HOOK_URL"
WH=$(curl -sS "$B/webhooks" -H "$K" -H "$J" -d "{\"url\":\"$HOOK_URL\",\"events\":[\"*\"],\"description\":\"curl quickstart\"}")
WH_ID=$(echo "$WH" | json id); SECRET=$(echo "$WH" | json secret)
echo "   id=$WH_ID secret=${SECRET:0:12}... (shown once; store it as COINVELLO_WEBHOOK_SECRET)"

echo "2) checkout session"
CS=$(curl -sS "$B/checkout-sessions" -H "$K" -H "$J" -H "Idempotency-Key: curl-quickstart-$(date +%s)" -d '{
  "amount": "49.99", "currency": "USD",
  "accepted_assets": ["btc:bitcoin", "usdt:tron", "usdc:polygon"],
  "order_id": "CURL-1",
  "success_url": "https://example.com/thanks", "cancel_url": "https://example.com/cart",
  "line_items": [{ "name": "Demo item", "quantity": 1, "unit_amount": "49.99" }],
  "metadata": { "order_id": "1" }
}')
CS_ID=$(echo "$CS" | json id); INV=$(echo "$CS" | json invoice_id); URL=$(echo "$CS" | json url)
echo "   session=$CS_ID invoice=$INV"
echo "   send the customer to: $URL"

echo "3) invoice before payment"
curl -sS "$B/invoices/$INV" -H "$K" | json status | sed 's/^/   status=/'

echo "4) simulate the customer paying 19 confirmations of USDT on Tron (test keys only)"
curl -sS "$B/test/simulate_payment" -H "$K" -H "$J" \
  -d "{\"invoice_id\":\"$INV\",\"asset\":\"usdt:tron\",\"confirmations\":19,\"tx_hash\":\"curl-demo\"}" >/dev/null

echo "5) invoice after payment"
curl -sS "$B/invoices/$INV" -H "$K" | json status | sed 's/^/   status=/'

echo "6) deliveries recorded for the endpoint"
curl -sS "$B/webhooks/$WH_ID/deliveries" -H "$K" | grep -o '"event_type":"[^"]*"' | sort | uniq -c | sed 's/^/   /' || true

if [[ "$HOOK_URL" == "$B/webhook-sink" ]]; then
  echo "7) verify the signature of the captured invoice.paid delivery (mock sink)"
  SINK=$(curl -sS "$B/webhook-sink" -H "$K")
  # Each sink entry is {"received_at","signature":"t=...,v1=...","event_id","raw":"<JSON-escaped body>","body":{...}}.
  FIRST=${SINK%%,\"body\":*}                       # newest entry, cut before its "body" key
  SIG=${FIRST#*\"signature\":\"}; SIG=${SIG%%\"*}
  T=${SIG#t=}; T=${T%%,*}; V1=${SIG##*v1=}
  RAW=${FIRST#*\"raw\":\"}; RAW=${RAW%\"}            # still JSON-escaped
  RAW=${RAW//\\\"/\"}; RAW=${RAW//\\\\/\\}          # unescape \" and \\
  EXPECTED=$(printf '%s.%s' "$T" "$RAW" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
  if [[ "$EXPECTED" == "$V1" ]]; then echo "   signature OK (HMAC-SHA256 of \"<t>.<raw body>\" with the whsec_ secret)"; else echo "   signature mismatch (check raw-body extraction)"; fi
fi

echo
echo "Done. Next: implement POST /webhooks/coinvello in your app (see the other cookbook files) and fulfil on invoice.paid."
