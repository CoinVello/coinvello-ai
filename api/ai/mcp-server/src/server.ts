/**
 * CoinVello MCP server: tools, resources and prompts.
 *
 * Tools talk to https://api.coinvello.com/v1 (or COINVELLO_API_BASE, e.g. the local reference
 * server at http://localhost:4242/v1) with the key from COINVELLO_API_KEY. Live keys (cv_live_)
 * are refused unless COINVELLO_ALLOW_LIVE=1 so an agent cannot accidentally touch mainnet money.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CoinVelloApiError, CoinVelloClient } from "./client.js";
import { verifyCoinVelloSignature } from "./verify.js";

export const SERVER_NAME = "coinvello";
export const SERVER_VERSION = "0.1.4";

export interface ServerConfig {
  apiKey?: string;
  baseUrl?: string;
  allowLive?: boolean;
  apiVersion?: string;
  /** Hosted (multi-user) mode: the key comes with each request, so errors explain how to send it. */
  hosted?: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    apiKey: env.COINVELLO_API_KEY,
    baseUrl: env.COINVELLO_API_BASE,
    allowLive: env.COINVELLO_ALLOW_LIVE === "1" || env.COINVELLO_ALLOW_LIVE === "true",
    apiVersion: env.COINVELLO_API_VERSION,
  };
}

/** Throws a clear error when the key is missing or is a live key without the explicit opt-in. */
export function assertKeyAllowed(cfg: ServerConfig): void {
  if (!cfg.apiKey && cfg.hosted) {
    throw new Error("No CoinVello API key on this request. Send it as `Authorization: Bearer cv_test_...` (or the `api_key` setting of this server in your MCP client). Create a test key at https://coinvello.com/app/settings.php (Settings -> API keys).");
  }
  if (!cfg.apiKey) {
    throw new Error(
      "COINVELLO_API_KEY is not set. Create a test key (cv_test_...) at https://coinvello.com/app/settings.php (Settings -> API keys), " +
        "or run the local mock (api/reference-server, npm start) and use any cv_test_ key with COINVELLO_API_BASE=http://localhost:4242/v1.",
    );
  }
  if (/^cv_live_/.test(cfg.apiKey) && !cfg.allowLive) {
    throw new Error(
      "Refusing to start with a LIVE key (cv_live_...). This server creates real invoices and credit purchases. " +
        "Use a cv_test_ key, or set COINVELLO_ALLOW_LIVE=1 if you really want an AI agent operating on mainnet.",
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Shared zod fragments (mirroring openapi.yaml)
// ---------------------------------------------------------------------------------------------
const Decimal = z.string().regex(/^-?\d+(\.\d+)?$/, "decimal string such as \"49.99\"");
const AssetId = z.string().regex(/^[a-z0-9]+:[a-z0-9]+$/, "asset id such as btc:bitcoin or usdc:polygon");
const Chain = z.enum(["bitcoin", "ethereum", "base", "arbitrum", "optimism", "polygon", "bnb", "avalanche", "robinhood", "solana", "tron"]);
const Metadata = z.record(z.string().max(500)).optional().describe("Up to 50 string key/value pairs returned on the object and in webhooks.");
const InvoiceStatus = z.enum(["new", "pending", "confirming", "paid", "underpaid", "overpaid", "expired", "cancelled", "refund_requested"]);
const PaymentStatus = z.enum(["detected", "confirming", "confirmed", "failed"]);
const Customer = z.object({ email: z.string().email().optional(), name: z.string().max(200).optional(), reference: z.string().max(128).optional() }).optional();

const RecordType = z.enum(["payment_received", "payment_reversed", "refund_sent", "fee_prepaid", "fee_onchain", "credit_purchase", "credit_adjustment", "conversion", "offramp_payout"]);
const ExportDataset = z.enum(["records", "invoices", "payments", "refunds", "sweeps", "credit_ledger", "credit_purchases", "conversions", "offramp_payouts", "all"]);
const ExportFormat = z.enum(["csv", "xlsx", "json"]);
const ExportPreset = z.enum(["generic", "journal", "quickbooks", "xero", "koinly", "cointracker", "coinledger"]);
const ExportStatus = z.enum(["queued", "processing", "ready", "failed", "expired"]);
const FiatCurrency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code such as USD or EUR");
const IncludeSimulated = z.boolean().optional().describe("Test mode only: include rows created by simulate_test_payment, which the sandbox hides by default. Ignored with a live key.");

const Paging = {
  limit: z.number().int().min(1).max(100).optional().describe("Page size (default 20)."),
  cursor: z.string().optional().describe("next_cursor from the previous page."),
};

function json(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: isObject(data) ? data : undefined };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toolError(e: unknown): CallToolResult {
  if (e instanceof CoinVelloApiError) {
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ http_status: e.status, error: e.error, hint: hintFor(e) }, null, 2) }],
    };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { type: "client_error", message: msg } }) }] };
}

function hintFor(e: CoinVelloApiError): string | undefined {
  switch (e.error.code) {
    case "insufficient_credits":
      return "The available credits cannot cover this invoice's estimated fee (details: available, required, bundles_url); the balance never goes below zero. Buy credits: list_credit_bundles -> create_credit_purchase -> pay the returned payment option (or open checkout_url). Or switch the account to pay as you go (billing_plan; auto_switch_to_pay_as_you_go, on by default, does it automatically where pay as you go is available). Test mode never runs out of credits.";
    case "asset_not_enabled":
    case "xpub_required":
      return "Bitcoin needs an extended public key: call create_wallet with type=xpub and the xpub/zpub/vpub, not a single address.";
    case "address_invalid":
      return "The address failed validation (format, checksum, network, zero/burn address or a token contract). Copy it again from the wallet; see error.param.";
    case "export_not_ready":
      return "The file is still being built: call get_export until status is ready, then use download_url.";
    case "export_expired":
      return "Export files are kept 7 days. Call create_export again with the same parameters.";
    case "test_mode_only":
      return "This endpoint only works with a cv_test_ key.";
    case "api_key_invalid":
    case "api_key_missing":
      return "Check COINVELLO_API_KEY. Keys look like cv_test_... or cv_live_...";
    case "resource_missing":
      return e.status === 404 && /\/wallets/.test(e.error.message ?? "")
        ? "The local reference server does not implement wallet CRUD; it pre-registers one mock wallet per chain."
        : "No object with that id in this mode (test objects are invisible to live keys and vice versa).";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Resource documents
// ---------------------------------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));

async function loadDoc(localCandidates: string[], remoteUrl: string): Promise<string> {
  for (const p of localCandidates) {
    try {
      return await readFile(p, "utf8");
    } catch {
      /* try next */
    }
  }
  const res = await fetch(remoteUrl);
  if (!res.ok) throw new Error(`Could not load ${remoteUrl}: ${res.status}`);
  return res.text();
}

const DOCS = {
  llmsFull: {
    local: [resolve(here, "docs", "llms-full.txt"), resolve(here, "..", "..", "llms-full.txt")],
    remote: "https://coinvello.com/llms-full.txt",
  },
  llms: {
    local: [resolve(here, "docs", "llms.txt"), resolve(here, "..", "..", "llms.txt")],
    remote: "https://coinvello.com/llms.txt",
  },
  openapi: {
    local: [resolve(here, "docs", "openapi.yaml"), resolve(here, "..", "..", "..", "openapi.yaml")],
    remote: "https://coinvello.com/.well-known/openapi.yaml",
  },
};

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------
const FRAMEWORKS = [
  "nextjs", "express", "fastapi", "flask", "django", "laravel", "rails", "sinatra", "go", "woocommerce", "shopify", "generic",
] as const;

function integrationPrompt(framework: string, extras: { currency?: string; assets?: string; language?: string }): string {
  const currency = extras.currency ?? "USD";
  const assets = extras.assets ?? "btc:bitcoin, eth:ethereum, usdc:polygon, usdt:tron";
  return [
    `Integrate CoinVello (non-custodial crypto payments, https://api.coinvello.com/v1) into this ${framework} project.`,
    "",
    "Read the resource coinvello://docs/llms-full.txt first; it contains the complete API contract and reference code.",
    "",
    "Requirements:",
    `1. Server-side only: read the API key from the COINVELLO_API_KEY environment variable (cv_test_ in development). Never ship it to the browser.`,
    `2. Add a "start payment" route that creates a checkout session with POST /checkout-sessions: amount as a decimal string, currency ${currency}, accepted_assets [${assets}], order_id, success_url, cancel_url, metadata.order_id, and an Idempotency-Key derived from the order id. Redirect the customer (303) to the returned url.`,
    "3. Add a webhook route at /webhooks/coinvello that reads the RAW request body, verifies the CoinVello-Signature header (t=<unix>,v1=<hex HMAC-SHA256 of \"<t>.<raw body>\" keyed with COINVELLO_WEBHOOK_SECRET; reject |now - t| > 300 s; constant-time compare; any v1 may match), dedupes on event.id, and fulfils the order ONLY on invoice.paid. Flag invoice.underpaid / overpaid / expired. Respond 2xx within 10 seconds.",
    "4. Store checkout session id and invoice id on the order so GET /invoices/{id} can be used for reconciliation.",
    "5. Keep amounts as strings everywhere; never convert to floats.",
    "6. Add the two environment variables to the project's example env file and document the setup in a few lines (create the webhook endpoint with POST /webhooks or the create_webhook tool, store the whsec_ secret).",
    "7. Verify end to end: with a cv_test_ key (or the local mock at http://localhost:4242/v1), create a session with create_checkout_session, run simulate_test_payment on its invoice_id with enough confirmations, and confirm the webhook handler marked the order paid.",
    "",
    "Use the framework's idioms (routing, env config, raw-body access). If a CoinVello cookbook recipe exists for this framework in api/ai/cookbook, follow its structure.",
    extras.language ? `Write the code in ${extras.language}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------------------------
export function createServer(cfg: ServerConfig = configFromEnv()): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        "CoinVello is a non-custodial crypto payment processor: payments go straight to the merchant's own wallet, no KYC/KYB, fees are prepaid credits bought in crypto, 11 networks.",
        "Typical flow: create_checkout_session -> redirect the customer to `url` -> fulfil on the `invoice.paid` webhook (verify with verify_webhook_signature) -> reconcile with get_invoice.",
        "Amounts are decimal strings. Asset ids are `<asset>:<chain>` like btc:bitcoin, usdc:polygon, usdt:tron.",
        "Bookkeeping and tax: list_records is the book of record (every payment, fee and credit purchase valued when it happened), get_records_summary gives period totals, create_export builds CSV/Excel/JSON files (with QuickBooks, Xero, Koinly, CoinTracker and CoinLedger presets). With a test key pass include_simulated=true to see simulated payments.",
        "Read coinvello://docs/llms-full.txt for the complete contract before writing integration code.",
        cfg.apiKey ? (/^cv_live_/.test(cfg.apiKey) ? "WARNING: a LIVE key is configured; tools create real objects." : "A test key is configured; nothing here touches mainnet.") : "No API key configured; tools will fail until COINVELLO_API_KEY is set.",
      ].join(" "),
    },
  );

  let client: CoinVelloClient | null = null;
  const api = (): CoinVelloClient => {
    if (!client) {
      assertKeyAllowed(cfg);
      client = new CoinVelloClient({ apiKey: cfg.apiKey!, baseUrl: cfg.baseUrl, apiVersion: cfg.apiVersion });
    }
    return client;
  };

  const run = async (fn: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return json(await fn());
    } catch (e) {
      return toolError(e);
    }
  };

  // ---------------------------------------------------------------- tools: checkout & invoices
  server.registerTool(
    "create_checkout_session",
    {
      title: "Create a hosted checkout session",
      description:
        "Create a CoinVello hosted checkout session (an invoice plus a payment page at pay.coinvello.com). Redirect the customer to the returned `url`. " +
        "Amounts are decimal strings. `currency` is an ISO code (USD, EUR...) or an asset id to price in crypto. Fulfil orders from the invoice.paid webhook, never from the redirect.",
      inputSchema: {
        amount: Decimal.describe("Total to charge, e.g. \"49.99\"."),
        currency: z.string().describe("ISO 4217 code such as USD/EUR/GBP, or an asset id such as btc:bitcoin."),
        success_url: z.string().url().describe("Where the hosted page sends the customer after payment."),
        cancel_url: z.string().url().optional(),
        accepted_assets: z.array(AssetId).optional().describe("Assets the customer may pay with; defaults to all assets with an enabled wallet."),
        order_id: z.string().max(128).optional().describe("Your order reference; indexed and searchable."),
        description: z.string().max(500).optional(),
        customer: Customer,
        line_items: z
          .array(z.object({ name: z.string().max(200), quantity: z.number().int().min(1), unit_amount: Decimal, description: z.string().max(500).optional(), image_url: z.string().url().optional() }))
          .optional(),
        redirect_on: z.enum(["confirming", "paid"]).optional().describe("When the hosted page redirects to success_url (default confirming)."),
        expires_in: z.number().int().min(300).max(86400).optional().describe("Seconds until expiry (default 1800)."),
        locale: z.string().optional(),
        branding: z.object({ theme: z.enum(["light", "dark", "auto"]).optional(), logo_url: z.string().url().optional(), primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), merchant_name: z.string().max(100).optional() }).optional(),
        collect_email: z.boolean().optional(),
        tax: z
          .object({ amount: Decimal, rate: Decimal.nullable().optional(), label: z.string().max(60).nullable().optional(), jurisdiction: z.string().max(20).nullable().optional() })
          .optional()
          .describe("The tax portion of the sale as you computed it, in the invoice currency and included in `amount` (e.g. {\"amount\":\"7.98\",\"rate\":\"0.19\",\"label\":\"VAT 19%\",\"jurisdiction\":\"DE\"}); copied to the records and exports. jurisdiction is a code you choose, never anything about the payer."),
        metadata: Metadata,
        idempotency_key: z.string().max(255).optional().describe("Stable key per order so retries do not create duplicate sessions, e.g. order-123-checkout."),
      },
    },
    async ({ idempotency_key, ...body }) => run(() => api().post("/checkout-sessions", body, idempotency_key)),
  );

  server.registerTool(
    "get_invoice",
    {
      title: "Get an invoice",
      description: "Retrieve an invoice (inv_...) with its status, payment_options (address, amount, payment_uri, qr_payload) and paid summary. Use for polling or reconciliation. Accepts a checkout session id (cs_...) too and returns the session with the invoice expanded.",
      inputSchema: { id: z.string().describe("inv_... or cs_... id") },
    },
    async ({ id }) =>
      run(() => (id.startsWith("cs_") ? api().get(`/checkout-sessions/${encodeURIComponent(id)}`, { expand: "invoice" }) : api().get(`/invoices/${encodeURIComponent(id)}`))),
  );

  server.registerTool(
    "list_invoices",
    {
      title: "List invoices",
      description: "List invoices, newest first, filterable by status, order_id or customer_email. Returns { object: 'list', data, has_more, next_cursor }.",
      inputSchema: {
        ...Paging,
        status: InvoiceStatus.optional(),
        order_id: z.string().optional(),
        customer_email: z.string().optional(),
        created_gte: z.string().optional().describe("RFC 3339 timestamp"),
        created_lte: z.string().optional().describe("RFC 3339 timestamp"),
      },
    },
    async (q) => run(() => api().get("/invoices", { ...q, "created[gte]": q.created_gte, "created[lte]": q.created_lte, created_gte: undefined, created_lte: undefined })),
  );

  server.registerTool(
    "list_payments",
    {
      title: "List payments",
      description: "List on-chain payments (pay_...) with tx_hash, confirmations, amount and status (detected, confirming, confirmed, failed). Filter by invoice_id, status, chain or tx_hash.",
      inputSchema: { ...Paging, invoice_id: z.string().optional(), status: PaymentStatus.optional(), chain: Chain.optional(), tx_hash: z.string().optional() },
    },
    async (q) => run(() => api().get("/payments", q)),
  );

  // ---------------------------------------------------------------- tools: wallets
  server.registerTool(
    "create_wallet",
    {
      title: "Register a merchant wallet",
      description:
        "Register a receiving wallet the merchant controls. type=xpub for bitcoin (CoinVello derives a fresh address per invoice from the extended PUBLIC key); type=address for ethereum, base, arbitrum, optimism, polygon, bnb, avalanche, robinhood, solana, tron. " +
        "Never pass a private key or seed phrase. The wallet is usable at once in live and test mode; addresses are validated strictly (format, checksum, network, no token contracts). For xpubs, show the returned first_address so the merchant can compare it with their wallet's first receive address. Signed-message verification (POST /wallets/{id}/verification then /verify) is optional and never required.",
      inputSchema: {
        type: z.enum(["xpub", "address"]),
        chain: Chain,
        label: z.string().max(100),
        xpub: z.string().optional().describe("xpub/ypub/zpub (BTC), tpub/upub/vpub (testnets) or an output descriptor. Required when type=xpub."),
        derivation_path: z.string().regex(/^m(\/\d+'?)*$/).optional().describe("Account path such as m/84'/0'/0'. Inferred from the prefix when omitted."),
        address_type: z.enum(["p2pkh", "p2sh-p2wpkh", "p2wpkh", "p2tr"]).optional(),
        start_index: z.number().int().min(0).optional(),
        address: z.string().optional().describe("Checksummed EVM address, Solana pubkey or Tron address. Required when type=address."),
        assets: z.array(AssetId).optional().describe("Assets accepted at this address, e.g. [\"usdc:polygon\",\"usdt:polygon\"]. Defaults to the native asset. Each must be listed by list_assets for the key's mode."),
        enabled: z.boolean().optional(),
        metadata: Metadata,
      },
    },
    async (body) => {
      if (body.type === "xpub" && body.xpub && /^(xprv|yprv|zprv|tprv|uprv|vprv|Ltpv)/.test(body.xpub)) {
        return toolError(new Error("That looks like an extended PRIVATE key (xprv). Refusing to send it. Export the extended public key (xpub/zpub/vpub) instead, and rotate this key."));
      }
      return run(() => api().post("/wallets", body));
    },
  );

  server.registerTool(
    "list_wallets",
    {
      title: "List wallets",
      description: "List registered wallets with chain, type, status (active/verified/archived) and accepted assets. Use it to see which assets can be offered on an invoice.",
      inputSchema: { ...Paging, chain: Chain.optional(), status: z.enum(["active", "verified", "archived", "unverified"]).optional() },
    },
    async (q) => run(() => api().get("/wallets", q)),
  );

  // ---------------------------------------------------------------- tools: webhooks
  server.registerTool(
    "create_webhook",
    {
      title: "Create a webhook endpoint",
      description:
        "Register a webhook endpoint. The response contains `secret` (whsec_...) ONCE: store it as COINVELLO_WEBHOOK_SECRET. Live endpoints must be HTTPS; test endpoints may be http://localhost. Use events [\"*\"] for everything or a list such as [\"invoice.paid\",\"invoice.expired\"].",
      inputSchema: {
        url: z.string().url(),
        events: z.array(z.string()).min(1).describe("Event types or [\"*\"]. Common: invoice.paid, invoice.confirming, invoice.underpaid, invoice.overpaid, invoice.expired, payment.detected, checkout_session.completed."),
        description: z.string().max(200).optional(),
        enabled: z.boolean().optional(),
        metadata: Metadata,
      },
    },
    async (body) => run(() => api().post("/webhooks", body)),
  );

  server.registerTool(
    "verify_webhook_signature",
    {
      title: "Verify a CoinVello-Signature header",
      description:
        "Verify a webhook delivery locally (no API call). Pass the exact raw request body, the CoinVello-Signature header (t=...,v1=...) and the endpoint secret (whsec_...). " +
        "Implements the spec: HMAC-SHA256 over \"<t>.<raw body>\", 300 s tolerance, constant-time compare against any v1. Returns valid=true/false with the reason and the parsed event. Set ignore_timestamp=true when checking an old captured delivery.",
      inputSchema: {
        raw_body: z.string().describe("Raw body bytes exactly as received (no re-serialisation)."),
        signature_header: z.string().describe("Value of the CoinVello-Signature header."),
        secret: z.string().describe("Endpoint secret whsec_..."),
        tolerance_seconds: z.number().int().min(0).optional(),
        ignore_timestamp: z.boolean().optional().describe("Skip the replay-window check (only for inspecting historical deliveries)."),
      },
    },
    async ({ raw_body, signature_header, secret, tolerance_seconds, ignore_timestamp }) => {
      const result = verifyCoinVelloSignature(raw_body, signature_header, secret, {
        toleranceSec: ignore_timestamp ? Number.MAX_SAFE_INTEGER : tolerance_seconds,
      });
      return { ...json(result), isError: false };
    },
  );

  // ---------------------------------------------------------------- tools: credits
  server.registerTool(
    "get_credits_balance",
    {
      title: "Get processing-credit balance",
      description: "Return the merchant's prepaid processing-credit balance: balance (= available + reserved, never negative), available (free to spend), reserved (estimated fees of open invoices paid with credits), low_balance_threshold, estimated_payments_remaining, auto_topup. There are no free live credits. 1 credit = $0.01 nominal; a confirmed payment consumes about 30 bps of its fiat value (floor 2, cap 2000).",
      inputSchema: {},
    },
    async () => run(() => api().get("/credits/balance")),
  );

  server.registerTool(
    "list_credit_bundles",
    {
      title: "List credit bundles",
      description: "List purchasable credit bundles with USD price, price_per_credit and indicative crypto_prices per asset. Bigger bundles cost less per credit (effective rate ~0.30% down to <0.10%).",
      inputSchema: {},
    },
    async () => run(() => api().get("/credits/bundles")),
  );

  server.registerTool(
    "create_credit_purchase",
    {
      title: "Buy credits (creates a crypto invoice)",
      description:
        "Create a crypto credit purchase (cpu_...). Returns payment.payment_options with the address/amount to pay (CoinVello's operator wallet) and a hosted checkout_url. Credits are added when the payment confirms. Card purchases and automatic top-up are set up by the merchant in the dashboard, not through this tool. In test mode credits are free, so this is mainly for exercising the flow (pay it with simulate_test_payment).",
      inputSchema: {
        bundle_id: z.string().describe("From list_credit_bundles, e.g. bnd_growth_15000."),
        pay_asset: z.string().optional().describe("Asset symbol to pay with, lowercase, e.g. usdt. Requires pay_chain. Omit for every option."),
        pay_chain: Chain.optional(),
        expires_in: z.number().int().min(600).max(86400).optional(),
        metadata: Metadata,
        idempotency_key: z.string().max(255).optional(),
      },
    },
    async ({ idempotency_key, ...body }) => run(() => api().post("/credits/purchases", body, idempotency_key)),
  );

  // ---------------------------------------------------------------- tools: records & exports
  server.registerTool(
    "list_records",
    {
      title: "List accounting records",
      description:
        "List the account's book of record, newest first: one immutable row per movement of value (payment_received, fee_prepaid, credit_purchase, refund_sent, fee_onchain, conversion, offramp_payout...) valued when it happened. " +
        "Each record has `value` (market value at the block time in the reporting currency, rate and source included), `value_usd`, `contract_value` (what the customer owed at the invoice's locked rate), `tax`, the on-chain proof (tx_hash, block_height, addresses, explorer_url) and an invoice snapshot. " +
        "`currency` re-values from value_usd at the historical rate. With a test key, rows created by simulate_test_payment appear only with include_simulated=true. Returns { object: 'list', data, has_more, next_cursor }.",
      inputSchema: {
        ...Paging,
        type: RecordType.optional(),
        asset: AssetId.optional().describe("Records whose received, sent or fee leg is this asset."),
        chain: Chain.optional(),
        invoice_id: z.string().optional(),
        order_id: z.string().optional(),
        tx_hash: z.string().optional(),
        occurred_gte: z.string().optional().describe("RFC 3339 timestamp; block time at or after."),
        occurred_lte: z.string().optional().describe("RFC 3339 timestamp; block time at or before."),
        currency: FiatCurrency.optional().describe("Re-value `value` into this currency (default: the account's reporting currency)."),
        include_simulated: IncludeSimulated,
      },
    },
    async (q) => run(() => api().get("/records", q)),
  );

  server.registerTool(
    "get_records_summary",
    {
      title: "Get totals for a period",
      description:
        "Sales (invoiced at the locked rates), received_market_value (what the coins were worth when they landed), valuation_difference, tax_collected, refunds, fees_prepaid and credits_consumed, fees_onchain, network_fees, credit_purchases and net_received, with payment counts, over occurred_at in the given timezone and currency. " +
        "period_start is inclusive and period_end exclusive (a date such as 2026-01-01, or a date-time). group_by returns the same totals per month, asset, chain, type or address in `groups`. With a test key, simulated rows count only with include_simulated=true.",
      inputSchema: {
        period_start: z.string().describe("Inclusive, read in `timezone`: a date (2026-01-01) or a date-time."),
        period_end: z.string().describe("Exclusive."),
        currency: FiatCurrency.optional(),
        timezone: z.string().optional().describe("IANA zone used to bucket occurred_at, e.g. Europe/Berlin. Default: the account's records timezone."),
        group_by: z.enum(["month", "asset", "chain", "type", "address"]).optional(),
        include_simulated: IncludeSimulated,
      },
    },
    async (q) => run(() => api().get("/records/summary", q)),
  );

  server.registerTool(
    "create_export",
    {
      title: "Export records as CSV, Excel or JSON",
      description:
        "Create an export of the records (default), another dataset, or `all` (the year-end package) for a period, or for the entire history when period is null or omitted. " +
        "Returns the export object: small exports are already `ready` with `file` (name, content_type, bytes, sha256) and a signed `download_url` valid until `download_expires_at` (files are kept 7 days); " +
        "while `queued` or `processing` call get_export. Vendor presets (quickbooks, xero, koinly, cointracker, coinledger) and journal need dataset=records and format=csv (otherwise 422). " +
        "Verify the downloaded file against file.sha256. With a test key pass include_simulated=true to include simulated payments.",
      inputSchema: {
        format: ExportFormat,
        dataset: ExportDataset.optional().describe("Default records."),
        preset: ExportPreset.optional().describe("Column layout for the records dataset (default generic)."),
        period: z
          .object({ start: z.string().describe("Inclusive, e.g. 2026-07-01."), end: z.string().describe("Exclusive, e.g. 2026-10-01.") })
          .nullable()
          .optional()
          .describe("Read in `timezone`. Null or omitted exports the entire history."),
        timezone: z.string().optional().describe("IANA zone, e.g. America/New_York. Default: the account's records timezone."),
        currency: FiatCurrency.optional().describe("Reporting currency of the value columns."),
        include_simulated: IncludeSimulated,
        metadata: Metadata,
        idempotency_key: z.string().max(255).optional().describe("Stable key so a retry does not start a second export, e.g. records-2026-q3."),
      },
    },
    async ({ idempotency_key, ...body }) => run(() => api().post("/exports", body, idempotency_key)),
  );

  server.registerTool(
    "get_export",
    {
      title: "Get an export",
      description: "Retrieve an export (exp_...): status (queued, processing, ready, failed, expired), rows, file { name, content_type, bytes, sha256 }, download_url and download_expires_at, failure_reason. Poll after create_export until ready.",
      inputSchema: { id: z.string().describe("exp_... id from create_export") },
    },
    async ({ id }) => run(() => api().get(`/exports/${encodeURIComponent(id)}`)),
  );

  // ---------------------------------------------------------------- tools: rates & assets
  server.registerTool(
    "get_rates",
    {
      title: "Get indicative exchange rates",
      description: "Mid-market rates for supported assets against a fiat base (default USD). Indicative only; invoices lock their own rate at creation.",
      inputSchema: {
        base: z.string().optional().describe("ISO 4217 code or asset id, default USD."),
        assets: z.array(AssetId).optional().describe("Restrict to these asset ids."),
      },
    },
    async ({ base, assets }) => run(() => api().get("/rates", { base, assets: assets?.join(",") })),
  );

  server.registerTool(
    "list_assets",
    {
      title: "List supported assets",
      description: "Every asset CoinVello accepts in the API key's mode: id (btc:bitcoin, usdc:polygon, eurc:base...), symbol, chain, kind (native/token), contract_address, decimals, required_confirmations, min_amount, testnet name and the wallet_type (xpub or address) needed to accept it. Tokens without a testnet contract (DAI, usdc:bnb, usdt on base/arbitrum/optimism/avalanche/solana, and the Bitcoin tokens wbtc/cbbtc/btcb) are live-only, so a test key does not list them.",
      inputSchema: { chain: Chain.optional().describe("Filter by chain.") },
    },
    async ({ chain }) =>
      run(async () => {
        const list = await api().get<{ data?: Array<{ chain?: string }> }>("/assets");
        if (chain && Array.isArray(list.data)) return { ...list, data: list.data.filter((a) => a.chain === chain) };
        return list;
      }),
  );

  // ---------------------------------------------------------------- tools: testing
  server.registerTool(
    "simulate_test_payment",
    {
      title: "Simulate a payment (test mode)",
      description:
        "Create a synthetic on-chain payment for an invoice (inv_) or credit purchase (cpu_) and run it through the real state machine and webhook pipeline. Test keys only. " +
        "confirmations=0 -> payment.detected / invoice.pending; confirmations >= required -> invoice.paid. Use a smaller/larger amount to simulate underpaid/overpaid. Reuse tx_hash to advance the same payment.",
      inputSchema: {
        invoice_id: z.string().describe("inv_... or cpu_..."),
        asset: AssetId.optional().describe("Which payment option to pay; defaults to the first accepted asset."),
        amount: Decimal.optional().describe("Amount in the asset; defaults to the exact payment_options[].amount."),
        confirmations: z.number().int().min(0).optional().describe("Default 0 (detected only)."),
        tx_hash: z.string().optional(),
        from_address: z.string().optional(),
        delay_seconds: z.number().int().min(0).max(300).optional(),
      },
    },
    async (body) => run(() => api().post("/test/simulate_payment", body)),
  );

  // ---------------------------------------------------------------- resources
  server.registerResource(
    "llms-full",
    "coinvello://docs/llms-full.txt",
    { title: "CoinVello complete integration guide", description: "Single-document API guide: auth, checkout sessions, redirect, webhook verification, polling, credits, errors, with curl/Node/Python/PHP examples.", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: await loadDoc(DOCS.llmsFull.local, DOCS.llmsFull.remote) }] }),
  );
  server.registerResource(
    "llms",
    "coinvello://docs/llms.txt",
    { title: "CoinVello llms.txt index", description: "Short, link-rich summary of the CoinVello API.", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: await loadDoc(DOCS.llms.local, DOCS.llms.remote) }] }),
  );
  server.registerResource(
    "openapi",
    "coinvello://openapi.yaml",
    { title: "CoinVello OpenAPI 3.1 specification", description: "Every endpoint, schema, example and webhook payload of https://api.coinvello.com/v1.", mimeType: "application/yaml" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/yaml", text: await loadDoc(DOCS.openapi.local, DOCS.openapi.remote) }] }),
  );

  // ---------------------------------------------------------------- prompts
  for (const fw of FRAMEWORKS) {
    server.registerPrompt(
      `integrate-coinvello-into-${fw}`,
      {
        title: `Integrate CoinVello into ${fw}`,
        description: `Step-by-step instructions for adding non-custodial crypto checkout (checkout session + verified webhook) to a ${fw} project.`,
        argsSchema: {
          currency: z.string().optional().describe("Pricing currency, default USD"),
          assets: z.string().optional().describe("Comma-separated asset ids, default btc:bitcoin, eth:ethereum, usdc:polygon, usdt:tron"),
        },
      },
      ({ currency, assets }) => ({
        messages: [{ role: "user", content: { type: "text", text: integrationPrompt(fw, { currency, assets }) } }],
      }),
    );
  }
  server.registerPrompt(
    "integrate-coinvello-into-framework",
    {
      title: "Integrate CoinVello into any framework",
      description: "Same procedure for a framework not listed; pass its name.",
      argsSchema: { framework: z.string().describe("e.g. Spring Boot, Phoenix, Hono"), currency: z.string().optional(), assets: z.string().optional() },
    },
    ({ framework, currency, assets }) => ({
      messages: [{ role: "user", content: { type: "text", text: integrationPrompt(framework, { currency, assets }) } }],
    }),
  );

  return server;
}
