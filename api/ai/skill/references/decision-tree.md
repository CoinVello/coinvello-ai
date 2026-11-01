# Which CoinVello integration path?

Walk the questions in order; stop at the first match.

```
Is the store on WooCommerce, Shopify, Magento 2, PrestaShop or OpenCart?
├─ yes ─> PLUGIN. Download from https://coinvello.com/integrations/<platform> (Shopify: pending approval,
│         use the API meanwhile), paste API key, configure the webhook URL the plugin shows.
│         Do not write custom payment code. Custom work = theming or order-status mapping only.
└─ no
   Does the project have a server (Node, Python, PHP, Ruby, Go, Java, .NET...)?
   ├─ no (static site, no backend) ─> Not directly possible: the API key must stay server-side.
   │         Options: add a tiny serverless function that creates the checkout session; or use the
   │         dashboard to create fixed-amount pay links manually and link to pay.coinvello.com.
   └─ yes
      Is the payer a human in a browser?
      ├─ no (machine-to-machine, B2B invoicing by email, kiosk, POS, mobile app) ─> DIRECT API.
      │         POST /invoices; email/display hosted_url or render payment_options (QR from qr_payload,
      │         deep link from payment_uri). Poll GET /invoices/{id} if webhooks cannot reach you.
      └─ yes
         Must the payment UI live inside the merchant's own page (modal / inline, no redirect)?
         ├─ yes ─> EMBEDDED WIDGET. Server creates the checkout session (POST /checkout-sessions);
         │         browser loads @coinvello/checkout (npm, or pay.coinvello.com/sdk/v1/checkout.js) and
         │         calls CoinVello.mount('#el', { sessionId, onPaid }) (inline) or
         │         CoinVello.redirectToCheckout({ sessionId }), or renders
         │         <coinvello-pay-button session-id="cs_..." mode="modal">. Only the session id is needed.
         │         Webhook handling identical to hosted checkout. The widget never sees the API key.
         └─ no ─> HOSTED CHECKOUT (default). POST /checkout-sessions -> 303 redirect to session.url
                   (pay.coinvello.com/c/cs_...). Customer picks asset, pays via QR / MetaMask /
                   WalletConnect / Phantom / TronLink, is redirected to success_url on confirming
                   (or paid). Fulfil on the invoice.paid webhook.

Special cases on top of any path:
- Price in crypto instead of fiat?            currency = "<asset>:<chain>" (e.g. "btc:bitcoin"), pricing becomes "crypto".
- Need a guaranteed rate before checkout?     POST /rates/quotes -> POST /rates/locks -> invoice.rate_lock_id.
- Only one asset accepted?                    accepted_assets = ["usdc:polygon"]; allow_asset_change = false.
- Save xpub address gap?                      payment_options_mode = "single" (derive on asset pick).
- Faster UX on slow chains?                   redirect_on = "confirming" (default) and treat confirming as
                                              "payment received, finalising"; fulfil only on paid.
- Refunds?                                    POST /refunds; CoinVello prepares the tx, merchant signs. Payer
                                              submits a return address on refund_claim_url.
- Converting to stablecoins / fiat?           Optional conversions and off-ramp endpoints; merchant signs swaps
                                              and connects their own partner account (KYC happens at the partner).
- An AI agent is doing the work?              Add the MCP server (npx -y @coinvello/mcp) so it can create sessions,
                                              simulate payments and verify signatures while it codes.
```

## Why hosted checkout is the default

- Zero payment UI to build or maintain; wallet buttons, QR codes, chain switching, rate refresh and
  live status (SSE + polling) are handled on pay.coinvello.com.
- Same webhook contract as every other path, so moving to the widget or direct API later changes one
  route, not the fulfilment logic.
- The customer-facing page never sees the merchant's API key; only an unguessable session id.

## When to pick direct API over the widget

- Non-browser contexts (email invoices, printed QR, POS terminals, mobile apps).
- You need your own layout for `payment_options` (QR codes per asset, copy address buttons).
- You price in crypto and want to show the exact on-chain amount in your own UI.

Direct API costs you: QR rendering, "pay with wallet" buttons (EIP-681 / BIP-21 / Solana Pay URIs are
provided), status polling or SSE on the public session endpoint, and expiry handling.
