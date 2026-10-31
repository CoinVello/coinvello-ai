// Generates anthropic-tools.json, openai-functions.json and gemini-function-declarations.json from
// the single source of truth below. Run: node build.mjs
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const decimal = { type: "string", pattern: "^-?\\d+(\\.\\d+)?$", description: "Decimal amount as a string, e.g. \"49.99\". Never a float." };
const assetId = { type: "string", pattern: "^[a-z0-9]+:[a-z0-9]+$", description: "Asset id <asset>:<chain>, e.g. btc:bitcoin, eth:ethereum, usdc:polygon, usdt:tron, eurc:base. Must be listed by GET /assets for the key's mode (some tokens, such as DAI, are live-only)." };
const metadata = { type: "object", description: "Up to 50 string key/value pairs returned on the object and in webhooks.", additionalProperties: { type: "string", maxLength: 500 } };
const customer = {
  type: "object",
  properties: { email: { type: "string", format: "email" }, name: { type: "string", maxLength: 200 }, reference: { type: "string", maxLength: 128, description: "Your customer id." } },
};
const tax = {
  type: "object",
  required: ["amount"],
  description: "The tax portion of the sale as you computed it: a decimal string in the invoice currency, included in `amount`. Copied to the invoice's records and exports. jurisdiction is a region code you choose (DE, US-CA), never anything about the payer.",
  properties: { amount: decimal, rate: { ...decimal, description: "Fraction, e.g. \"0.19\" for 19%." }, label: { type: "string", maxLength: 60, description: "e.g. VAT 19%." }, jurisdiction: { type: "string", maxLength: 20 } },
};
const fiatCurrency = { type: "string", pattern: "^[A-Z]{3}$", description: "ISO 4217 code such as USD or EUR." };
const includeSimulated = { type: "boolean", description: "Test mode only: include rows created by /test/simulate_payment, which the sandbox hides by default. Ignored with a live key." };
const invoiceStatus = ["new", "pending", "confirming", "paid", "underpaid", "overpaid", "expired", "cancelled", "refund_requested"];

const invoiceFields = {
  amount: { ...decimal, description: "Total to charge as a decimal string, e.g. \"49.99\"." },
  currency: { type: "string", description: "ISO 4217 fiat code (USD, EUR, GBP...) or an asset id (btc:bitcoin) to price in crypto." },
  accepted_assets: { type: "array", items: assetId, description: "Assets the customer may pay with. Defaults to every asset with an enabled wallet." },
  order_id: { type: "string", maxLength: 128, description: "Your order reference. Indexed and searchable." },
  description: { type: "string", maxLength: 500 },
  customer,
  success_url: { type: "string", format: "uri", description: "Where the hosted page sends the customer after payment." },
  cancel_url: { type: "string", format: "uri" },
  expires_in: { type: "integer", minimum: 300, maximum: 86400, description: "Seconds until expiry. Default 1800." },
  tax,
  metadata,
};

/** Shared tool definitions. `http` documents how to execute each call. */
const tools = [
  {
    name: "coinvello_create_checkout_session",
    description:
      "Create a CoinVello hosted checkout session: an invoice plus a payment page at pay.coinvello.com. Redirect the customer to the returned `url`; fulfil the order on the `invoice.paid` webhook, never on the redirect. CoinVello is non-custodial: funds go straight to the merchant's wallet.",
    http: { method: "POST", path: "/checkout-sessions", idempotent: true },
    parameters: {
      type: "object",
      required: ["amount", "currency", "success_url"],
      properties: {
        ...invoiceFields,
        success_url: { ...invoiceFields.success_url },
        line_items: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "quantity", "unit_amount"],
            properties: { name: { type: "string", maxLength: 200 }, quantity: { type: "integer", minimum: 1 }, unit_amount: decimal, description: { type: "string", maxLength: 500 }, image_url: { type: "string", format: "uri" } },
          },
        },
        redirect_on: { type: "string", enum: ["confirming", "paid"], description: "When the hosted page redirects to success_url. Default confirming." },
        locale: { type: "string", description: "BCP-47 or auto." },
        branding: {
          type: "object",
          properties: { theme: { type: "string", enum: ["light", "dark", "auto"] }, logo_url: { type: "string", format: "uri" }, primary_color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, merchant_name: { type: "string", maxLength: 100 } },
        },
        collect_email: { type: "boolean" },
      },
    },
  },
  {
    name: "coinvello_create_invoice",
    description:
      "Create a bare CoinVello invoice when you render the payment UI yourself. Returns `hosted_url` and `payment_options[]` with a merchant-owned `address`, exact `amount`, `payment_uri` (BIP-21 / EIP-681 / Solana Pay) and `qr_payload` per asset.",
    http: { method: "POST", path: "/invoices", idempotent: true },
    parameters: {
      type: "object",
      required: ["amount", "currency"],
      properties: {
        ...invoiceFields,
        rate_lock: { type: "boolean", description: "Hold crypto amounts fixed until expiry. Default true." },
        required_confirmations: { type: "object", description: "Per-asset override, e.g. {\"btc:bitcoin\": 2}.", additionalProperties: { type: "integer", minimum: 0, maximum: 100 } },
        underpayment_tolerance: { ...decimal, description: "Fraction that may be missing and still count as paid, e.g. \"0.01\". Default 0.5%." },
        overpayment_tolerance: { ...decimal, description: "Fraction above which the invoice is overpaid. Default 2%." },
        payment_options_mode: { type: "string", enum: ["all", "single"], description: "all = derive an address per asset now; single = derive when the customer picks." },
      },
    },
  },
  {
    name: "coinvello_get_invoice",
    description: "Retrieve a CoinVello invoice by id (inv_...) to check `status` (new, pending, confirming, paid, underpaid, overpaid, expired, cancelled, refund_requested), `paid` summary and `payment_options`. Use for polling or reconciliation.",
    http: { method: "GET", path: "/invoices/{invoice_id}" },
    parameters: {
      type: "object",
      required: ["invoice_id"],
      properties: { invoice_id: { type: "string", pattern: "^inv_", description: "Invoice id, e.g. inv_9XyZ12AbC3." } },
    },
  },
  {
    name: "coinvello_list_invoices",
    description: "List CoinVello invoices newest first with optional filters. Returns { object: \"list\", data: [...], has_more, next_cursor }.",
    http: { method: "GET", path: "/invoices" },
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: invoiceStatus },
        order_id: { type: "string" },
        customer_email: { type: "string", format: "email" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size, default 20." },
        cursor: { type: "string", description: "next_cursor from the previous page." },
      },
    },
  },
  {
    name: "coinvello_create_webhook",
    description:
      "Register a CoinVello webhook endpoint. The response includes `secret` (whsec_...) exactly once; store it to verify the CoinVello-Signature header (t=<unix>,v1=<hex HMAC-SHA256 of \"<t>.<raw body>\"). Live URLs must be HTTPS; test mode allows http://localhost.",
    http: { method: "POST", path: "/webhooks", idempotent: true },
    parameters: {
      type: "object",
      required: ["url", "events"],
      properties: {
        url: { type: "string", format: "uri" },
        events: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description: "Event types or [\"*\"]. Common: invoice.paid, invoice.confirming, invoice.underpaid, invoice.overpaid, invoice.expired, payment.detected, checkout_session.completed.",
        },
        description: { type: "string", maxLength: 200 },
        enabled: { type: "boolean" },
        metadata,
      },
    },
  },
  {
    name: "coinvello_simulate_test_payment",
    description:
      "Test mode only (cv_test_ key). Create a synthetic payment for an invoice (inv_) or credit purchase (cpu_) and run it through the real state machine and webhook pipeline. confirmations >= the asset's required confirmations marks the invoice paid; a smaller/larger amount simulates underpaid/overpaid.",
    http: { method: "POST", path: "/test/simulate_payment" },
    parameters: {
      type: "object",
      required: ["invoice_id"],
      properties: {
        invoice_id: { type: "string", description: "inv_... or cpu_..." },
        asset: { ...assetId, description: "Payment option to pay. Defaults to the first accepted asset." },
        amount: { ...decimal, description: "Amount in the asset. Defaults to the exact payment_options[].amount." },
        confirmations: { type: "integer", minimum: 0, description: "0 = detected only. Default 0." },
        tx_hash: { type: "string", description: "Reuse to advance the same payment instead of adding a second one." },
        delay_seconds: { type: "integer", minimum: 0, maximum: 300 },
      },
    },
  },
  {
    name: "coinvello_list_records",
    description:
      "List the CoinVello book of record, newest first: one immutable row per movement of value (payment_received, fee_prepaid, credit_purchase, refund_sent, fee_onchain, conversion, offramp_payout...) valued when it happened. Each record has `value` (market value at the block time in the reporting currency, with rate and source), `value_usd`, `contract_value` (what the customer owed at the invoice's locked rate), `tax`, the on-chain proof and an invoice snapshot. Returns { object: \"list\", data: [...], has_more, next_cursor }. With a test key, simulated payments need include_simulated=true.",
    http: { method: "GET", path: "/records" },
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["payment_received", "payment_reversed", "refund_sent", "fee_prepaid", "fee_onchain", "credit_purchase", "credit_adjustment", "conversion", "offramp_payout"] },
        asset: { ...assetId, description: "Records whose received, sent or fee leg is this asset." },
        chain: { type: "string", enum: ["bitcoin", "ethereum", "base", "arbitrum", "optimism", "polygon", "bnb", "avalanche", "robinhood", "solana", "tron"] },
        invoice_id: { type: "string" },
        order_id: { type: "string" },
        tx_hash: { type: "string" },
        occurred_gte: { type: "string", format: "date-time", description: "Block time at or after this RFC 3339 timestamp." },
        occurred_lte: { type: "string", format: "date-time", description: "Block time at or before this RFC 3339 timestamp." },
        currency: { ...fiatCurrency, description: "Re-value `value` into this currency from value_usd at the historical rate. Default: the account's reporting currency." },
        include_simulated: includeSimulated,
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size, default 20." },
        cursor: { type: "string", description: "next_cursor from the previous page." },
      },
    },
  },
  {
    name: "coinvello_get_records_summary",
    description:
      "Totals for a period from the CoinVello book of record: sales (at the locked rates), received_market_value, valuation_difference, tax_collected, refunds, fees_prepaid and credits_consumed, fees_onchain, network_fees, credit_purchases, net_received and payment counts, over occurred_at in the given timezone and currency. period_start is inclusive, period_end exclusive. group_by returns the same totals per month, asset, chain, type or address in `groups`.",
    http: { method: "GET", path: "/records/summary" },
    parameters: {
      type: "object",
      required: ["period_start", "period_end"],
      properties: {
        period_start: { type: "string", description: "Inclusive, read in `timezone`: a date (2026-01-01) or a date-time." },
        period_end: { type: "string", description: "Exclusive: a date (2027-01-01) or a date-time." },
        currency: fiatCurrency,
        timezone: { type: "string", description: "IANA zone used to bucket occurred_at, e.g. Europe/Berlin. Default: the account's records timezone." },
        group_by: { type: "string", enum: ["month", "asset", "chain", "type", "address"] },
        include_simulated: includeSimulated,
      },
    },
  },
  {
    name: "coinvello_create_export",
    description:
      "Create a CoinVello export: a CSV, Excel (xlsx) or JSON file of the records (default), another dataset, or `all` (the year-end package), for a period or the entire history (period null). Returns the export object; small exports are already `ready` with `file` (name, content_type, bytes, sha256) and a signed `download_url` (kept 7 days); otherwise poll coinvello_get_export. Vendor presets (quickbooks, xero, koinly, cointracker, coinledger) and journal need dataset=records and format=csv, else 422. Verify the download against file.sha256.",
    http: { method: "POST", path: "/exports", idempotent: true },
    parameters: {
      type: "object",
      required: ["format"],
      properties: {
        format: { type: "string", enum: ["csv", "xlsx", "json"] },
        dataset: { type: "string", enum: ["records", "invoices", "payments", "refunds", "sweeps", "credit_ledger", "credit_purchases", "conversions", "offramp_payouts", "all"], description: "Default records." },
        preset: { type: "string", enum: ["generic", "journal", "quickbooks", "xero", "koinly", "cointracker", "coinledger"], description: "Column layout for the records dataset. Default generic." },
        period: {
          type: ["object", "null"],
          description: "Read in `timezone`; start inclusive, end exclusive. Null or omitted exports the entire history.",
          properties: { start: { type: "string", description: "e.g. 2026-07-01." }, end: { type: "string", description: "e.g. 2026-10-01." } },
          required: ["start", "end"],
        },
        timezone: { type: "string", description: "IANA zone, e.g. America/New_York. Default: the account's records timezone." },
        currency: { ...fiatCurrency, description: "Reporting currency of the value columns." },
        include_simulated: includeSimulated,
        metadata,
      },
    },
  },
  {
    name: "coinvello_get_export",
    description: "Retrieve a CoinVello export (exp_...): status (queued, processing, ready, failed, expired), rows, file { name, content_type, bytes, sha256 }, download_url, download_expires_at and failure_reason. Poll after coinvello_create_export until ready.",
    http: { method: "GET", path: "/exports/{export_id}" },
    parameters: {
      type: "object",
      required: ["export_id"],
      properties: { export_id: { type: "string", pattern: "^exp_", description: "Export id, e.g. exp_5Mn8Qr2Tv4." } },
    },
  },
];

// ---- Anthropic tool use: { name, description, input_schema } ----------------------------------
const anthropic = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

// ---- OpenAI function calling (Chat Completions `tools` array) ---------------------------------
const openai = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

// ---- Gemini function declarations: OpenAPI-subset schema, no `format`/`pattern`/`additionalProperties`
function geminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (["format", "pattern", "additionalProperties", "minLength", "maxLength", "minItems", "maxItems"].includes(k)) continue;
    if (k === "type" && typeof v === "string") { out.type = v.toUpperCase(); continue; }
    if (k === "type" && Array.isArray(v)) { out.type = String(v.find((x) => x !== "null")).toUpperCase(); if (v.includes("null")) out.nullable = true; continue; }
    if (k === "properties") { out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiSchema(pv)])); continue; }
    if (k === "items") { out.items = geminiSchema(v); continue; }
    out[k] = v;
  }
  // Gemini requires OBJECT schemas to declare properties; metadata-style free objects become STRING (JSON) hints.
  if (out.type === "OBJECT" && !out.properties) {
    return { type: "STRING", description: (out.description ?? "") + " Pass as a JSON object string." };
  }
  return out;
}
const gemini = { function_declarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) };

// ---- HTTP mapping for the executor --------------------------------------------------------------
const mapping = Object.fromEntries(tools.map((t) => [t.name, t.http]));

const write = (name, data) => writeFileSync(resolve(here, name), JSON.stringify(data, null, 2) + "\n");
write("anthropic-tools.json", anthropic);
write("openai-functions.json", openai);
write("gemini-function-declarations.json", gemini);
write("http-mapping.json", { base_url: "https://api.coinvello.com/v1", auth_header: "Authorization: Bearer <COINVELLO_API_KEY>", tools: mapping });
console.log("wrote anthropic-tools.json, openai-functions.json, gemini-function-declarations.json, http-mapping.json");
