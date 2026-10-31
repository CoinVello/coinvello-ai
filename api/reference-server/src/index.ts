/**
 * CoinVello reference mock server.
 *
 *   npm install && npm run dev      -> http://localhost:4242/v1
 *
 * Accepts any API key beginning with `cv_test_`. Implements the subset of api/openapi.yaml that
 * plugins and SDKs need in CI: invoices, payments, checkout sessions, webhooks (with real HMAC
 * signing and delivery), credits (balance, bundles, purchases, ledger), rates, assets, events,
 * records and exports (src/records.ts), and POST /test/simulate_payment. State lives in memory and resets on restart.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  API_VERSION, ASSETS, DISPLAY_PER_USD, FEE_BPS, assetsFor, explorer, FIAT_RATES_USD, STABLECOINS, STABLECOIN_DISCOUNT_BPS, Store, TEST_MODE_TOPUP, creditsForUsd, fakeAddress, fakeTxHash, fromMinor, id, newSecret, now, paginate, plusSeconds,
  EXPLORERS, signPayload, toMinor, type CheckoutSession, type CreditPurchase, type Delivery, type Event, type ExportObject, type Invoice, type InvoiceStatus, type InvoiceTax, type Payable, type Payment, type Webhook,
} from "./store.js";
import { ApiError } from "./errors.js";
import {
  GROUP_BY, RECORD_TYPES, buildExportFile, buildSummary, checkCurrency, filterRecords, isValidTimeZone, parseBoundary, parseExportRequest, recordCreditPurchase, recordFee, recordPaymentReceived, retentionMs, revalue,
} from "./records.js";

const PORT = Number(process.env.PORT ?? 4242);
const PAY_BASE = process.env.PAY_BASE_URL ?? "https://pay.coinvello.com";
const WEBHOOK_TIMEOUT_MS = 10_000;

export const store = new Store();
export const app = express();

// ----------------------------------------------------------------- plumbing
const notFound = (what: string, idv: string, param: string) => new ApiError(404, "invalid_request_error", "resource_missing", `No such ${what}: ${idv}`, param);
const invalidState = (msg: string) => new ApiError(409, "invalid_request_error", "invalid_state", msg);
const missing = (param: string) => new ApiError(400, "invalid_request_error", "parameter_missing", `${param} is required.`, param);
const invalid = (param: string, msg: string) => new ApiError(400, "invalid_request_error", "parameter_invalid", msg, param);

const jsonParser = express.json({ limit: "1mb" });
app.use((req, res, next) => (req.path.startsWith("/v1/webhook-sink") ? next() : jsonParser(req, res, next)));
app.use((req, res, next) => {
  res.setHeader("Request-Id", id("req"));
  res.setHeader("CoinVello-Version", API_VERSION);
  res.setHeader("RateLimit-Limit", "100");
  res.setHeader("RateLimit-Remaining", "99");
  res.setHeader("RateLimit-Reset", String(Math.floor(Date.now() / 1000) + 1));
  next();
});

const PUBLIC = new Set(["/v1/assets", "/v1/credits/bundles", "/v1/offramp/providers", "/v1/health", "/v1/rates/display"]);
const isPublicSession = (p: string) => /^\/v1\/checkout[-_]sessions\/[^/]+\/(public|events)$/.test(p);
app.use((req, res, next) => {
  if (isPublicSession(req.path)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Accept, Last-Event-ID");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    return next();
  }
  if (PUBLIC.has(req.path) || req.path.startsWith("/v1/webhook-sink") || req.path.startsWith("/v1/export-files/")) return next();
  const auth = req.header("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/.exec(auth);
  if (!m) return next(new ApiError(401, "authentication_error", "api_key_missing", "No API key provided. Use Authorization: Bearer cv_test_..."));
  if (m[1].startsWith("cv_live_")) return next(new ApiError(403, "permission_error", "live_mode_unsupported", "The reference server only accepts test keys (cv_test_...)."));
  if (!m[1].startsWith("cv_test_")) return next(new ApiError(401, "authentication_error", "api_key_invalid", "Invalid API key provided."));
  next();
});

// Idempotency: replay stored responses for POST with Idempotency-Key.
app.use((req, res, next) => {
  if (req.method !== "POST") return next();
  const key = req.header("idempotency-key");
  if (!key) return next();
  const scope = `${req.path}|${key}`;
  const hit = store.idempotency.get(scope);
  const bodyHash = JSON.stringify(req.body ?? {});
  if (hit) {
    if ((hit as { bodyHash?: string }).bodyHash !== bodyHash) return next(new ApiError(409, "idempotency_error", "idempotency_key_reused", "Idempotency-Key was used with a different request body."));
    res.setHeader("Idempotency-Replayed", "true");
    return res.status(hit.status).json(hit.body);
  }
  const json = res.json.bind(res);
  res.json = (body: unknown) => { store.idempotency.set(scope, { status: res.statusCode, body, bodyHash } as never); return json(body); };
  next();
});

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

// ----------------------------------------------------------------- events & webhooks
async function emit(type: string, object: unknown, extra: Record<string, unknown> = {}, previous?: Record<string, unknown>) {
  const evt: Event = {
    id: id("evt"), object: "event", type, livemode: false, api_version: API_VERSION, created_at: now(),
    data: { object, ...(previous ? { previous_attributes: previous } : {}), ...extra },
    request: { id: null, idempotency_key: null }, pending_webhooks: 0,
  };
  store.events.set(evt.id, evt);
  const targets = [...store.webhooks.values()].filter((w) => w.enabled && (w.events.includes("*") || w.events.includes(type)));
  evt.pending_webhooks = targets.length;
  await Promise.all(targets.map((w) => deliver(w, evt, 1)));
  return evt;
}

async function deliver(w: Webhook, evt: Event, attempt: number, replayed = false) {
  const body = JSON.stringify(evt);
  const d: Delivery = { id: id("whd"), object: "webhook_delivery", webhook_id: w.id, event_id: evt.id, event_type: evt.type, attempt, status: "pending", response_status: null, error: null, duration_ms: null, next_retry_at: null, replayed, created_at: now() };
  store.deliveries.set(d.id, d);
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
    const res = await fetch(w.url, {
      method: "POST", signal: ctrl.signal, body,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "CoinVello-Webhooks/1.0 (+https://coinvello.com/webhooks) reference-server",
        "CoinVello-Signature": signPayload(body, w.secret),
        "CoinVello-Event-Id": evt.id, "CoinVello-Event-Type": evt.type, "CoinVello-Webhook-Id": w.id,
        "CoinVello-Delivery-Id": d.id, "CoinVello-Delivery-Attempt": String(attempt),
        ...(replayed ? { "CoinVello-Delivery-Replayed": "true" } : {}),
      },
    });
    clearTimeout(t);
    Object.assign(d, { status: res.ok ? "succeeded" : "failed", response_status: res.status, duration_ms: Date.now() - started });
  } catch (e) {
    Object.assign(d, { status: "failed", error: (e as Error).message, duration_ms: Date.now() - started });
  }
  w.last_delivery_at = now();
  if (d.status === "failed") { d.next_retry_at = plusSeconds(60); log(`webhook ${w.id} -> ${w.url} failed (${d.error ?? d.response_status})`); }
  else log(`webhook ${w.id} -> ${w.url} ${evt.type} ${d.response_status}`);
  return d;
}

const log = (msg: string) => { if (process.env.QUIET !== "1") console.log(`[coinvello-mock] ${msg}`); };

// ----------------------------------------------------------------- payment state machine (shared by invoices & purchases)
function applyPayment(p: Payable, payments: Payment[], asset: string): { status: InvoiceStatus; prev: InvoiceStatus } {
  const prev = p.status;
  const opt = p.payment_options.find((o) => o.asset === asset)!;
  const relevant = payments.filter((x) => x.asset === asset && x.status !== "failed");
  const due = toMinor(opt.amount, opt.decimals);
  const received = relevant.reduce((s, x) => s + BigInt(x.amount_minor), 0n);
  const confirmedReceived = relevant.filter((x) => x.status === "confirmed").reduce((s, x) => s + BigInt(x.amount_minor), 0n);
  const underTol = due - (due * BigInt(Math.round(Number(p.underpayment_tolerance) * 10000))) / 10000n;
  const overTol = due + (due * BigInt(Math.round(Number(p.overpayment_tolerance) * 10000))) / 10000n;
  const minConf = Math.min(...relevant.map((x) => x.confirmations), 0);
  const fiatRate = Number(opt.rate);

  p.paid = {
    asset, amount_received: fromMinor(received, opt.decimals),
    amount_received_fiat: (Number(fromMinor(received, opt.decimals)) * fiatRate).toFixed(2),
    amount_due: opt.amount, amount_remaining: fromMinor(received >= due ? 0n : due - received, opt.decimals),
    confirmations: relevant.length ? Math.max(...relevant.map((x) => x.confirmations)) : 0, required_confirmations: opt.required_confirmations,
    payment_ids: relevant.map((x) => x.id),
  };

  if (["paid", "underpaid", "overpaid", "cancelled", "refund_requested"].includes(prev)) return { status: prev, prev };
  const expired = new Date(p.expires_at).getTime() < Date.now() || prev === "expired";
  let status: InvoiceStatus = prev;
  if (confirmedReceived >= underTol) {
    status = confirmedReceived > overTol ? "overpaid" : "paid";
    p.paid_at = now();
    opt.status = "paid";
  } else if (received >= underTol) {
    status = expired ? "expired" : "confirming";
  } else if (relevant.length) {
    // some payment, insufficient
    const allConfirmed = relevant.every((x) => x.status === "confirmed");
    status = expired ? "expired" : allConfirmed && minConf >= 0 && relevant.length > 0 && (prev === "confirming" || prev === "pending") && allConfirmed ? "pending" : "pending";
    if (expired && allConfirmed && received > 0n) status = "underpaid";
  }
  p.status = status;
  return { status, prev };
}

function invoiceStatusEvents(status: InvoiceStatus): string | null {
  return ({ pending: "invoice.pending", confirming: "invoice.confirming", paid: "invoice.paid", underpaid: "invoice.underpaid", overpaid: "invoice.overpaid", expired: "invoice.expired", cancelled: "invoice.cancelled", refund_requested: "invoice.refund_requested" } as Record<string, string>)[status] ?? null;
}

function expireIfDue(inv: Invoice) {
  if ((inv.status === "new" || inv.status === "pending") && new Date(inv.expires_at).getTime() < Date.now()) {
    const prev = inv.status; inv.status = "expired"; inv.updated_at = now();
    void emit("invoice.expired", inv, {}, { status: prev });
    notifyPublic(inv.id);
  }
}

// ----------------------------------------------------------------- routes: meta
app.get("/v1/health", (_req, res) => res.json({ ok: true, version: API_VERSION, invoices: store.invoices.size }));

// With a key the key prefix picks the mode; without one, the optional CoinVello-Livemode header does (default live).
app.get("/v1/assets", (req, res) => {
  const key = /^Bearer\s+(cv_(?:live|test)_)/.exec(req.header("authorization") ?? "")?.[1];
  const livemode = key ? key === "cv_live_" : String(req.header("coinvello-livemode") ?? "true").toLowerCase() !== "false";
  res.json({
    object: "list",
    data: assetsFor(livemode).map((a) => ({ id: a.id, object: "asset", symbol: a.symbol, name: a.name, chain: a.chain, kind: a.kind, contract_address: a.contract_address, decimals: a.decimals, required_confirmations: a.required_confirmations, min_amount: a.min_amount, testnet: a.testnet, wallet_type: a.chain === "bitcoin" ? "xpub" : "address" })),
  });
});

function displayRates(base: string) {
  const b = base.toUpperCase();
  if (!DISPLAY_PER_USD[b]) throw new ApiError(400, "invalid_request_error", "currency_unsupported", `Unsupported currency ${b}.`, "base");
  const rates: Record<string, string> = {};
  for (const [c, v] of Object.entries(DISPLAY_PER_USD)) if (c !== b) { const r = v / DISPLAY_PER_USD[b]; rates[c] = r < 0.01 ? r.toFixed(6) : r.toFixed(4); }
  return { object: "display_rates", base: b, rates, as_of: now(), source: "static" };
}
app.get("/v1/rates/display", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.json(displayRates(String(req.query.base ?? "USD")));
});
const account = { id: "mer_mock", object: "account", email: "merchant@example.com", business_name: "Mock Merchant", status: "active", mfa_required: false, locale: null as string | null, display_currency: null as string | null, auto_switch_to_pay_as_you_go: true, records: { reporting_currency: "USD", fiscal_year_start: "01-01", timezone: "UTC" }, api_version: API_VERSION, created_at: now(), last_seen_at: null as string | null };
app.get("/v1/account", (_req, res) => res.json(account));
app.patch("/v1/account", h((req, res) => {
  const b = req.body ?? {};
  if (b.business_name !== undefined) account.business_name = b.business_name;
  if (b.locale !== undefined) account.locale = b.locale;
  if (b.display_currency !== undefined) { const c = b.display_currency === null ? null : String(b.display_currency).toUpperCase(); if (c && !DISPLAY_PER_USD[c]) throw new ApiError(400, "invalid_request_error", "currency_unsupported", `Unsupported currency ${c}.`, "display_currency"); account.display_currency = c; }
  if (b.auto_switch_to_pay_as_you_go !== undefined) {
    if (typeof b.auto_switch_to_pay_as_you_go !== "boolean") throw invalid("auto_switch_to_pay_as_you_go", "auto_switch_to_pay_as_you_go must be a boolean.");
    account.auto_switch_to_pay_as_you_go = b.auto_switch_to_pay_as_you_go;
  }
  if (b.records !== undefined) {
    const r = b.records;
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw invalid("records", "records must be an object.");
    const next = { ...account.records };
    if (r.reporting_currency !== undefined) next.reporting_currency = checkCurrency(r.reporting_currency, "records.reporting_currency");
    if (r.fiscal_year_start !== undefined) {
      if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(r.fiscal_year_start))) throw invalid("records.fiscal_year_start", "fiscal_year_start must be MM-DD.");
      next.fiscal_year_start = String(r.fiscal_year_start);
    }
    if (r.timezone !== undefined) {
      if (!isValidTimeZone(String(r.timezone))) throw invalid("records.timezone", `${r.timezone} is not an IANA time zone.`);
      next.timezone = String(r.timezone);
    }
    account.records = next;
  }
  res.json(account);
}));

app.get("/v1/rates", (req, res) => {
  const base = String(req.query.base ?? "USD").toUpperCase();
  const fx = FIAT_RATES_USD[base] ?? 1;
  const wanted = typeof req.query.assets === "string" && req.query.assets ? String(req.query.assets).split(",") : ASSETS.map((a) => a.id);
  res.json({ object: "rates", base, rates: ASSETS.filter((a) => wanted.includes(a.id)).map((a) => ({ asset: a.id, rate: (a.rate_usd / fx).toFixed(a.rate_usd > 10 ? 2 : 4), source: "mock" })), as_of: now() });
});

// ----------------------------------------------------------------- routes: invoices
/** The tax portion of a sale, in the invoice currency and included in `amount`; `jurisdiction` is a code the merchant picks. */
function parseTax(raw: unknown, amount: string): InvoiceTax | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("tax", "tax must be an object.");
  const t = raw as Record<string, unknown>;
  const decimal = (v: unknown) => typeof v === "string" && /^\d+(\.\d+)?$/.test(v);
  if (!decimal(t.amount)) throw invalid("tax.amount", "tax.amount must be a decimal string.");
  if (Number(t.amount) > Number(amount)) throw invalid("tax.amount", "tax.amount is included in the invoice amount and cannot exceed it.");
  if (t.rate !== undefined && t.rate !== null && !decimal(t.rate)) throw invalid("tax.rate", "tax.rate must be a decimal string such as \"0.19\".");
  for (const [k, max] of [["label", 60], ["jurisdiction", 20]] as const) if (t[k] !== undefined && t[k] !== null && (typeof t[k] !== "string" || (t[k] as string).length > max)) throw invalid(`tax.${k}`, `tax.${k} must be a string of at most ${max} characters.`);
  return { amount: t.amount as string, rate: (t.rate as string | null | undefined) ?? null, label: (t.label as string | null | undefined) ?? null, jurisdiction: (t.jurisdiction as string | null | undefined) ?? null };
}

/**
 * An invoice paid with credits needs its estimated fee available (balance minus what open invoices reserve).
 * Like production test mode the mock never runs out: it tops the balance up instead. Set MOCK_CREDITS_RUN_OUT=1 to
 * behave like a live prepaid account that cannot switch to pay as you go: `402 insufficient_credits`.
 */
function reserveCredits(required: number): void {
  const available = Math.max(0, store.credits.balance - store.reservedCredits());
  if (available >= required) return;
  if (process.env.MOCK_CREDITS_RUN_OUT === "1") {
    throw new ApiError(402, "credits_error", "insufficient_credits", `This invoice needs ${required} credits and ${available} are available. Buy credits at https://coinvello.com/app/credits, or switch to pay as you go.`, undefined, { available, required, bundles_url: "https://api.coinvello.com/v1/credits/bundles" });
  }
  store.addLedger("credit", "bonus", Math.max(TEST_MODE_TOPUP, required), null, "Test-mode credits top-up (test credits never run out)");
}

function createInvoice(body: Record<string, any>, checkoutSessionId: string | null = null): Invoice {
  if (!body.amount) throw missing("amount");
  if (!/^\d+(\.\d+)?$/.test(String(body.amount))) throw invalid("amount", "amount must be a decimal string.");
  if (!body.currency) throw missing("currency");
  const currency = String(body.currency);
  const pricing: "fiat" | "crypto" = currency.includes(":") ? "crypto" : "fiat";
  if (pricing === "fiat" && !FIAT_RATES_USD[currency.toUpperCase()]) throw new ApiError(400, "invalid_request_error", "currency_unsupported", `Unsupported currency ${currency}.`, "currency");
  if (pricing === "crypto" && !ASSETS.some((a) => a.id === currency)) throw new ApiError(400, "invalid_request_error", "currency_unsupported", `Unknown asset ${currency}.`, "currency");
  const accepted: string[] = Array.isArray(body.accepted_assets) && body.accepted_assets.length ? body.accepted_assets : pricing === "crypto" ? [currency] : ASSETS.map((a) => a.id);
  for (const [i, a] of accepted.entries()) if (!ASSETS.some((x) => x.id === a)) throw new ApiError(422, "invalid_request_error", "asset_not_enabled", `No enabled wallet accepts ${a}.`, `accepted_assets[${i}]`);
  // Reserve the estimated fee so the balance can never go below zero (docs/03-fees-and-credits.md "Running out of credits").
  const usdValue = pricing === "fiat" ? Number(body.amount) * (FIAT_RATES_USD[currency.toUpperCase()] ?? 1) : Number(body.amount) * (ASSETS.find((a) => a.id === currency)?.rate_usd ?? 0);
  const feeEstimate = creditsForUsd(usdValue);
  reserveCredits(feeEstimate);

  const tax = parseTax(body.tax, String(body.amount));
  const expiresIn = Math.min(Math.max(Number(body.expires_in ?? 1800), 300), 86400);
  const invId = id("inv");
  const { options, rates } = store.buildPaymentOptions(String(body.amount), pricing === "fiat" ? currency.toUpperCase() : currency, accepted, store.wallets, body.description ?? body.order_id, body.required_confirmations ?? {});
  const inv: Invoice = {
    id: invId, object: "invoice", livemode: false, status: "new", amount: String(body.amount), currency: pricing === "fiat" ? currency.toUpperCase() : currency, pricing,
    accepted_assets: accepted, payment_options: options, paid: null,
    order_id: body.order_id ?? null, description: body.description ?? null, customer: body.customer,
    success_url: body.success_url ?? null, cancel_url: body.cancel_url ?? null,
    hosted_url: `${PAY_BASE}/i/${invId}`, refund_claim_url: null,
    rate_lock: { id: `rl_auto_${invId.slice(4)}`, locked: body.rate_lock !== false, locked_until: plusSeconds(expiresIn), rates },
    required_confirmations: Object.fromEntries(options.map((o) => [o.asset, o.required_confirmations])),
    underpayment_tolerance: String(body.underpayment_tolerance ?? "0.005"), overpayment_tolerance: String(body.overpayment_tolerance ?? "0.02"),
    checkout_session_id: checkoutSessionId, fee: null, tax, metadata: body.metadata ?? {},
    expires_at: plusSeconds(expiresIn), paid_at: null, created_at: now(), updated_at: now(),
  };
  store.invoices.set(inv.id, inv);
  store.reservations.set(inv.id, feeEstimate);
  void emit("invoice.created", inv);
  return inv;
}

app.post("/v1/invoices", h((req, res) => res.status(201).json(createInvoice(req.body ?? {}))));

app.get("/v1/invoices", h((req, res) => {
  let items = [...store.invoices.values()];
  items.forEach(expireIfDue);
  if (req.query.status) items = items.filter((i) => i.status === req.query.status);
  if (req.query.order_id) items = items.filter((i) => i.order_id === req.query.order_id);
  res.json(paginate(items, req.query as Record<string, unknown>));
}));

const getInvoice = (idv: string) => { const inv = store.invoices.get(idv); if (!inv) throw notFound("invoice", idv, "invoice_id"); expireIfDue(inv); return inv; };

app.get("/v1/invoices/:id", h((req, res) => res.json(getInvoice(req.params.id))));
app.patch("/v1/invoices/:id", h((req, res) => {
  const inv = getInvoice(req.params.id);
  if (!["new", "pending"].includes(inv.status)) throw invalidState(`Invoice ${inv.id} is ${inv.status} and cannot be updated.`);
  for (const k of ["description", "metadata", "success_url", "cancel_url"] as const) if (req.body?.[k] !== undefined) (inv as any)[k] = req.body[k];
  inv.updated_at = now();
  res.json(inv);
}));
app.post("/v1/invoices/:id/cancel", h(async (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!["new", "pending"].includes(inv.status)) throw invalidState(`Invoice ${inv.id} is ${inv.status} and cannot be cancelled.`);
  const prev = inv.status; inv.status = "cancelled"; inv.updated_at = now();
  await emit("invoice.cancelled", inv, {}, { status: prev });
  notifyPublic(inv.id); res.json(inv);
}));
app.post("/v1/invoices/:id/expire", h(async (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!["new", "pending"].includes(inv.status)) throw invalidState(`Invoice ${inv.id} is ${inv.status} and cannot be expired.`);
  const prev = inv.status; inv.status = "expired"; inv.expires_at = now(); inv.updated_at = now();
  await emit("invoice.expired", inv, {}, { status: prev });
  notifyPublic(inv.id); res.json(inv);
}));
app.get("/v1/invoices/:id/payments", h((req, res) => {
  getInvoice(req.params.id);
  res.json(paginate([...store.payments.values()].filter((p) => p.invoice_id === req.params.id), req.query as Record<string, unknown>));
}));

// ----------------------------------------------------------------- routes: payments
app.get("/v1/payments", h((req, res) => {
  let items = [...store.payments.values()];
  for (const k of ["invoice_id", "status", "chain", "tx_hash"] as const) if (req.query[k]) items = items.filter((p) => String(p[k]) === req.query[k]);
  res.json(paginate(items, req.query as Record<string, unknown>));
}));
app.get("/v1/payments/:id", h((req, res) => { const p = store.payments.get(req.params.id); if (!p) throw notFound("payment", req.params.id, "payment_id"); res.json(p); }));

// ----------------------------------------------------------------- routes: checkout sessions
const checkoutHandler = h((req, res) => {
  const body = req.body ?? {};
  if (!body.success_url) throw missing("success_url");
  if (Array.isArray(body.line_items) && body.line_items.length) {
    const sum = body.line_items.reduce((s: number, li: any) => s + Number(li.unit_amount) * Number(li.quantity ?? 1), 0);
    if (Math.abs(sum - Number(body.amount)) > 0.005) throw invalid("line_items", `line_items sum ${sum.toFixed(2)} does not equal amount ${body.amount}.`);
  }
  const csId = id("cs");
  const inv = createInvoice(body, csId);
  const cs: CheckoutSession = {
    id: csId, object: "checkout_session", livemode: false, status: "open", url: `${PAY_BASE}/c/${csId}`, invoice_id: inv.id, invoice_status: inv.status,
    amount: inv.amount, currency: inv.currency, order_id: inv.order_id, success_url: body.success_url, cancel_url: body.cancel_url ?? null,
    redirect_on: body.redirect_on ?? "confirming", line_items: body.line_items ?? [], customer: body.customer, selected_asset: null,
    metadata: body.metadata ?? {}, expires_at: inv.expires_at, completed_at: null, created_at: now(),
  };
  store.checkoutSessions.set(cs.id, cs);
  res.status(201).json(cs);
});
app.post("/v1/checkout-sessions", checkoutHandler);
app.post("/v1/checkout_sessions", checkoutHandler);

function syncSession(cs: CheckoutSession) {
  const inv = store.invoices.get(cs.invoice_id)!; expireIfDue(inv);
  cs.invoice_status = inv.status;
  if (cs.status === "open") {
    if (["paid", "overpaid", "underpaid"].includes(inv.status) || (cs.redirect_on === "confirming" && inv.status === "confirming")) { cs.status = "complete"; cs.completed_at = now(); void emit("checkout_session.completed", cs); }
    else if (["expired", "cancelled"].includes(inv.status)) { cs.status = "expired"; void emit("checkout_session.expired", cs); }
  }
  return inv;
}
const getSession = (idv: string) => { const cs = store.checkoutSessions.get(idv); if (!cs) throw notFound("checkout_session", idv, "checkout_session_id"); return cs; };
for (const base of ["/v1/checkout-sessions", "/v1/checkout_sessions"]) {
  app.get(base, h((req, res) => { const items = [...store.checkoutSessions.values()]; items.forEach(syncSession); res.json(paginate(req.query.status ? items.filter((c) => c.status === req.query.status) : items, req.query as Record<string, unknown>)); }));
  app.get(`${base}/:id`, h((req, res) => { const cs = getSession(req.params.id); const inv = syncSession(cs); res.json(req.query.expand === "invoice" ? { ...cs, invoice: inv } : cs); }));
  app.post(`${base}/:id/expire`, h(async (req, res) => {
    const cs = getSession(req.params.id); const inv = syncSession(cs);
    if (cs.status !== "open") throw invalidState(`Checkout session ${cs.id} is ${cs.status}.`);
    const prev = inv.status; inv.status = "expired"; inv.expires_at = now(); await emit("invoice.expired", inv, {}, { status: prev });
    syncSession(cs); notifyPublic(inv.id); res.json(cs);
  }));
}

// ----------------------------------------------------------------- public checkout view + SSE

function publicStatus(st: InvoiceStatus): string {
  return st === "new" ? "pending" : st === "refund_requested" ? "paid" : st;
}

/** Resolve a public id (cs_ or cpu_) to the redacted projection, or undefined. */
function publicView(pubId: string): Record<string, unknown> | undefined {
  let payable: Payable; let purpose: "payment" | "credits"; let merchant: { name: string; logo_url: string | null };
  let description: string | null; let success_url: string | null = null; let cancel_url: string | null = null; let redirect_on: string | undefined; let targetId: string; let updated_at: string;
  const cs = store.checkoutSessions.get(pubId);
  if (cs) {
    const inv = syncSession(cs); payable = inv; purpose = "payment"; targetId = inv.id;
    merchant = { name: "Mock Merchant", logo_url: null }; description = inv.description ?? (inv.order_id ? `Order ${inv.order_id}` : null);
    success_url = cs.success_url; cancel_url = cs.cancel_url; redirect_on = cs.redirect_on; updated_at = inv.updated_at;
  } else {
    const cp = store.purchases.get(pubId); if (!cp) return undefined;
    payable = cp.payment; purpose = "credits"; targetId = cp.id;
    const bundle = store.bundles.find((b) => b.id === cp.bundle_id);
    merchant = { name: "CoinVello", logo_url: `${PAY_BASE}/coinvello-mark.svg` }; description = `${cp.credits.toLocaleString("en-US")} credits${bundle ? ` - ${bundle.name}` : ""}`;
    success_url = "https://coinvello.com/app/credits.php"; updated_at = cp.updated_at;
  }
  const rateLockedUntil = (payable as Invoice).rate_lock?.locked_until ?? (payable as CreditPurchase["payment"]).rate_locked_until ?? payable.expires_at;
  const payments = [...store.payments.values()].filter((p) => p.invoice_id === targetId).map((p) => ({
    id: p.id, chain: p.chain, asset: p.asset, symbol: ASSETS.find((a) => a.id === p.asset)?.symbol ?? p.asset, tx_hash: p.tx_hash, amount: p.amount, amount_minor: p.amount_minor,
    status: p.status, confirmations: p.confirmations, required_confirmations: p.required_confirmations, explorer_url: explorer(p.chain, "tx", p.tx_hash), detected_at: p.detected_at, confirmed_at: p.confirmed_at,
  }));
  const st = publicStatus(payable.status);
  let balance_delta: string | null = null;
  if (payable.paid && (st === "underpaid" || st === "overpaid")) {
    const opt = payable.payment_options.find((o) => o.asset === payable.paid!.asset)!;
    balance_delta = ((Number(payable.paid.amount_received) - Number(opt.amount)) * Number(opt.rate)).toFixed(2);
  }
  return {
    id: pubId, object: "checkout_session.public", livemode: false, purpose, merchant, amount: payable.amount, currency: payable.currency, description,
    status: st, expires_at: payable.expires_at,
    payment_options: payable.payment_options.map((o) => ({ ...o, uri: o.payment_uri, chain_id: o.network_id, token_contract: o.contract_address, rate_locked_until: rateLockedUntil, explorer_url: explorer(o.chain, "address", o.address) })),
    paid: payable.paid, payments, success_url, cancel_url, ...(redirect_on ? { redirect_on } : {}),
    address_manifest: null, balance_delta,
    display_rates: payable.currency.includes(":") || !DISPLAY_PER_USD[payable.currency] ? null : displayRates(payable.currency),
    locale_hints: purpose === "payment" && (account.locale || account.display_currency) ? { merchant_locale: account.locale, suggested_currency: account.display_currency } : null,
    branding: { theme: "auto", primary_color: null }, locale: null, updated_at,
  };
}

const sseClients = new Map<string, Set<{ res: Response; seq: number }>>();
const TERMINAL = new Set(["paid", "overpaid", "underpaid", "expired", "cancelled"]);
function sseSend(res: Response, event: string, data: unknown, idv?: number) {
  res.write(`event: ${event}\n${idv !== undefined ? `id: ${idv}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
}
/** Push the current public view to every SSE client watching a session/purchase (looked up by its own id or by its invoice id). */
function notifyPublic(targetId: string) {
  const pubId = store.checkoutSessions.get(targetId)?.id ?? [...store.checkoutSessions.values()].find((c) => c.invoice_id === targetId)?.id ?? (store.purchases.has(targetId) ? targetId : undefined);
  if (!pubId) return;
  const clients = sseClients.get(pubId); if (!clients?.size) return;
  const view = publicView(pubId); if (!view) return;
  for (const c of clients) { c.seq++; sseSend(c.res, "status", view, c.seq); }
  if (TERMINAL.has(view.status as string)) setTimeout(() => { for (const c of clients) c.res.end(); clients.clear(); }, 2000);
}

for (const base of ["/v1/checkout-sessions", "/v1/checkout_sessions"]) {
  app.get(`${base}/:id/public`, h((req, res) => {
    const view = publicView(req.params.id); if (!view) throw notFound("checkout_session", req.params.id, "checkout_session_id");
    res.setHeader("Cache-Control", "no-store"); res.json(view);
  }));
  app.get(`${base}/:id/events`, h((req, res) => {
    const view = publicView(req.params.id); if (!view) throw notFound("checkout_session", req.params.id, "checkout_session_id");
    res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const client = { res, seq: Number(req.header("last-event-id") ?? 0) || 0 };
    const set = sseClients.get(req.params.id) ?? new Set(); set.add(client); sseClients.set(req.params.id, set);
    client.seq++; sseSend(res, "status", view, client.seq);
    const hb = setInterval(() => sseSend(res, "heartbeat", { ts: now() }), 15_000);
    req.on("close", () => { clearInterval(hb); set.delete(client); });
    if (TERMINAL.has(view.status as string)) setTimeout(() => { clearInterval(hb); set.delete(client); res.end(); }, 2000);
  }));
}

// ----------------------------------------------------------------- routes: webhooks
const publicWebhook = (w: Webhook, withSecret = false) => { const { secret, ...rest } = w; return withSecret ? { ...rest, secret } : rest; };
app.post("/v1/webhooks", h((req, res) => {
  const b = req.body ?? {};
  if (!b.url) throw missing("url");
  if (!Array.isArray(b.events) || !b.events.length) throw missing("events");
  const w: Webhook = { id: id("whe"), object: "webhook", livemode: false, url: String(b.url), description: b.description ?? null, events: b.events, enabled: b.enabled !== false, secret: newSecret(), api_version: b.api_version ?? API_VERSION, status: "active", last_delivery_at: null, created_at: now(), updated_at: now() };
  store.webhooks.set(w.id, w);
  res.status(201).json(publicWebhook(w, true));
}));
app.get("/v1/webhooks", h((req, res) => res.json({ ...paginate([...store.webhooks.values()], req.query as Record<string, unknown>), data: [...store.webhooks.values()].map((w) => publicWebhook(w)) })));
const getWebhook = (idv: string) => { const w = store.webhooks.get(idv); if (!w) throw notFound("webhook", idv, "webhook_id"); return w; };
app.get("/v1/webhooks/:id", h((req, res) => res.json(publicWebhook(getWebhook(req.params.id)))));
app.patch("/v1/webhooks/:id", h((req, res) => { const w = getWebhook(req.params.id); for (const k of ["url", "description", "events", "enabled", "api_version"] as const) if (req.body?.[k] !== undefined) (w as any)[k] = req.body[k]; w.updated_at = now(); res.json(publicWebhook(w)); }));
app.delete("/v1/webhooks/:id", h((req, res) => { getWebhook(req.params.id); store.webhooks.delete(req.params.id); res.json({ id: req.params.id, object: "webhook", deleted: true }); }));
app.post("/v1/webhooks/:id/rotate_secret", h((req, res) => { const w = getWebhook(req.params.id); w.secret = newSecret(); w.updated_at = now(); res.json({ ...publicWebhook(w, true), previous_secret_expires_at: plusSeconds(Number(req.body?.grace_period_seconds ?? 86400)) }); }));
app.post("/v1/webhooks/:id/test", h(async (req, res) => {
  const w = getWebhook(req.params.id);
  const type = req.body?.event_type ?? "ping";
  const sample = type === "ping" ? { object: "ping", message: "Hello from CoinVello", sent_at: now() } : ([...store.invoices.values()][0] ?? { object: "invoice", id: "inv_sample", status: "paid" });
  const evt: Event = { id: id("evt"), object: "event", type, livemode: false, api_version: API_VERSION, created_at: now(), data: { object: sample }, request: { id: null, idempotency_key: null }, pending_webhooks: 1 };
  res.json(await deliver(w, evt, 1));
}));
app.get("/v1/webhooks/:id/deliveries", h((req, res) => { getWebhook(req.params.id); let items = [...store.deliveries.values()].filter((d) => d.webhook_id === req.params.id); if (req.query.status) items = items.filter((d) => d.status === req.query.status); res.json(paginate(items, req.query as Record<string, unknown>)); }));
app.post("/v1/webhooks/:id/deliveries/:did/retry", h(async (req, res) => {
  const w = getWebhook(req.params.id); const d = store.deliveries.get(req.params.did); if (!d) throw notFound("webhook_delivery", req.params.did, "delivery_id");
  const evt = store.events.get(d.event_id); if (!evt) throw notFound("event", d.event_id, "event_id");
  res.json(await deliver(w, evt, d.attempt + 1));
}));

/** Convenience sink: point a webhook at http://localhost:4242/v1/webhook-sink to see deliveries logged. */
const sink: unknown[] = [];
app.post("/v1/webhook-sink", express.raw({ type: "*/*" }), (req, res) => {
  const raw: string = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  let body: unknown = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
  sink.unshift({ received_at: now(), signature: req.header("CoinVello-Signature"), event_id: req.header("CoinVello-Event-Id"), raw, body });
  log(`sink received ${req.header("CoinVello-Event-Type")}`);
  res.sendStatus(200);
});
app.get("/v1/webhook-sink", (_req, res) => res.json({ object: "list", data: sink.slice(0, 50) }));

// ----------------------------------------------------------------- routes: events
app.get("/v1/events", h((req, res) => {
  let items = [...store.events.values()];
  if (typeof req.query.type === "string") { const t = req.query.type; items = items.filter((e) => t.endsWith("*") ? e.type.startsWith(t.slice(0, -1)) : e.type === t); }
  if (req.query.related_object_id) items = items.filter((e) => (e.data.object as any)?.id === req.query.related_object_id);
  res.json(paginate(items, req.query as Record<string, unknown>));
}));
app.get("/v1/events/:id", h((req, res) => { const e = store.events.get(req.params.id); if (!e) throw notFound("event", req.params.id, "event_id"); res.json(e); }));
app.post("/v1/events/:id/resend", h(async (req, res) => {
  const e = store.events.get(req.params.id); if (!e) throw notFound("event", req.params.id, "event_id");
  const wid = req.body?.webhook_id;
  const targets = wid ? [getWebhook(String(wid))] : [...store.webhooks.values()].filter((w) => w.enabled && (w.events.includes("*") || w.events.includes(e.type)));
  const deliveries = await Promise.all(targets.map((w) => deliver(w, e, 1, true)));
  res.json({ object: "event_resend", event_id: e.id, deliveries });
}));
app.post("/v1/webhooks/:id/replay", h(async (req, res) => {
  const w = getWebhook(req.params.id);
  const b = req.body ?? {};
  if (!b.since) throw missing("since");
  const since = new Date(String(b.since)); const until = b.until ? new Date(String(b.until)) : new Date();
  if (Number.isNaN(since.getTime())) throw invalid("since", "since must be an RFC 3339 timestamp.");
  const types: string[] | null = Array.isArray(b.types) && b.types.length ? b.types : null;
  const matching = [...store.events.values()]
    .filter((e) => new Date(e.created_at) >= since && new Date(e.created_at) <= until && (w.events.includes("*") || w.events.includes(e.type)) && (!types || types.includes(e.type)))
    .sort((a, c) => (a.created_at < c.created_at ? -1 : 1)).slice(0, 1000);
  const deliveries = await Promise.all(matching.map((e) => deliver(w, e, 1, true)));
  res.json({ object: "webhook_replay", webhook_id: w.id, since: since.toISOString(), until: until.toISOString(), types, events_matched: matching.length, deliveries_enqueued: deliveries.length, truncated: false, oldest_event_id: matching[0]?.id ?? null, newest_event_id: matching[matching.length - 1]?.id ?? null });
}));

// ----------------------------------------------------------------- routes: credits
const balance = () => {
  const fees = store.ledger.filter((l) => l.type === "debit" && (l.reason === "invoice_fee" || l.reason === "checkout_fee"));
  const avg = fees.length ? fees.reduce((s, l) => s + l.amount, 0) / fees.length : 24;
  const reserved = store.reservedCredits();
  const available = store.credits.balance - reserved;
  const est = Math.max(0, Math.floor(available / avg));
  return {
    object: "credits_balance", livemode: false, balance: store.credits.balance, available, reserved,
    expiring_soon: { credits: 0, before: plusSeconds(30 * 86400) },
    low_balance_threshold: 200, estimated_payments_remaining: est, estimated_invoices_remaining: est, auto_topup: { enabled: false }, updated_at: now(),
  };
};
app.get("/v1/credits/balance", (_req, res) => res.json(balance()));
app.get("/v1/credits/bundles", (_req, res) => res.json({
  object: "list",
  data: store.bundles.filter((b) => b.enabled).map((b) => ({
    ...b,
    crypto_prices: b.monthly || b.contact_sales ? [] : ASSETS.filter((a) => [...store.operatorWallets.values()].some((w) => w.assets.includes(a.id))).map((a) => {
      const disc = STABLECOINS.has(a.id.split(":")[0]);
      const usd = Number(b.price.amount) * (disc ? 1 - b.stablecoin_discount_bps / 10000 : 1);
      const q = fromMinor(BigInt(Math.round(usd / a.rate_usd * 10 ** a.decimals)), a.decimals);
      return { asset: a.id, amount: q, rate: a.rate_usd.toFixed(a.rate_usd > 10 ? 2 : 4), discount_applied: disc };
    }),
    rates_as_of: now(),
  })),
}));
app.post("/v1/credits/purchases", h((req, res) => {
  const b = req.body ?? {};
  if (!b.bundle_id) throw missing("bundle_id");
  const bundle = store.bundles.find((x) => x.id === b.bundle_id && x.enabled);
  if (!bundle) throw notFound("credit_bundle", b.bundle_id, "bundle_id");
  if (bundle.monthly) throw invalidState(`${bundle.id} is granted automatically every month and cannot be purchased.`);
  if (bundle.contact_sales) throw invalidState(`${bundle.id} is priced individually - contact support@coinvello.com.`);
  let assets = ASSETS.map((a) => a.id);
  // The mock has no card processor: card purchases need the real backend (Square sandbox in test mode).
  if (b.payment_method) throw new ApiError(422, "card_error", "card_payments_unavailable", "Card payments are not available on the reference server.", "payment_method");
  if (b.pay_asset || b.pay_chain) {
    if (!b.pay_asset || !b.pay_chain) throw invalid("pay_asset", "pay_asset and pay_chain must be given together.");
    const aid = `${String(b.pay_asset).toLowerCase()}:${String(b.pay_chain).toLowerCase()}`;
    if (![...store.operatorWallets.values()].some((w) => w.assets.includes(aid))) throw new ApiError(422, "invalid_request_error", "asset_not_enabled", `Credits cannot be paid in ${aid}.`, "pay_asset");
    assets = [aid];
  }
  const expiresIn = Math.min(Math.max(Number(b.expires_in ?? 3600), 600), 86400);
  // 3% stablecoin discount applies when the purchase is pinned to a single stablecoin option
  const stable = assets.length === 1 && STABLECOINS.has(assets[0].split(":")[0]);
  const charged = stable ? (Number(bundle.price.amount) * (1 - bundle.stablecoin_discount_bps / 10000)).toFixed(2) : bundle.price.amount;
  const { options } = store.buildPaymentOptions(charged, "USD", assets, store.operatorWallets, `CoinVello credits - ${bundle.name}`);
  const pid = id("cpu");
  const purchase: CreditPurchase = {
    id: pid, object: "credit_purchase", livemode: false, status: "new", method: "crypto", card: null, failure: null, bundle_id: bundle.id, credits: bundle.credits + bundle.bonus_credits,
    price: { amount: charged, currency: "USD" }, list_price: bundle.price, discount: stable ? { type: "stablecoin", bps: bundle.stablecoin_discount_bps } : null,
    payment: { status: "new", amount: charged, currency: "USD", payment_options: options, rate_locked_until: plusSeconds(Math.min(expiresIn, 900)), paid: null, payment_ids: [], underpayment_tolerance: "0.005", overpayment_tolerance: "0.02", expires_at: plusSeconds(expiresIn), paid_at: null },
    checkout_url: `${PAY_BASE}/credits/${pid}`, credits_added_at: null, ledger_entry_id: null, metadata: b.metadata ?? {}, created_at: now(), updated_at: now(),
  };
  store.purchases.set(pid, purchase);
  res.status(201).json(purchase);
}));
app.get("/v1/credits/purchases", h((req, res) => { let items = [...store.purchases.values()]; if (req.query.status) items = items.filter((p) => p.status === req.query.status); res.json(paginate(items, req.query as Record<string, unknown>)); }));
const getPurchase = (idv: string) => { const p = store.purchases.get(idv); if (!p) throw notFound("credit_purchase", idv, "purchase_id"); return p; };
app.get("/v1/credits/purchases/:id", h((req, res) => res.json(getPurchase(req.params.id))));
app.post("/v1/credits/purchases/:id/cancel", h((req, res) => { const p = getPurchase(req.params.id); if (!["new", "pending"].includes(p.status)) throw invalidState(`Purchase ${p.id} is ${p.status}.`); p.status = p.payment.status = "cancelled"; p.updated_at = now(); notifyPublic(p.id); res.json(p); }));
app.get("/v1/credits/ledger", h((req, res) => { let items = store.ledger; if (req.query.type) items = items.filter((l) => l.type === req.query.type); if (req.query.reason) items = items.filter((l) => l.reason === req.query.reason); res.json(paginate(items, req.query as Record<string, unknown>)); }));
app.put("/v1/credits/auto_topup", h((req, res) => {
  // Automatic top-up charges a saved card, and the mock has none.
  if ((req.body ?? {}).enabled) throw new ApiError(422, "card_error", "payment_method_required", "Automatic top-up charges a saved card; the reference server has no card processor.", "payment_method");
  res.json(balance());
}));
app.get("/v1/credits/payment_methods", (_req, res) => res.json({ object: "list", data: [], has_more: false, next_cursor: null, card_payments_available: false, card_form: null }));

// ----------------------------------------------------------------- routes: records
const flag = (v: unknown, param: string) => {
  if (v === undefined) return false;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw invalid(param, `${param} must be true or false.`);
};
const when = (v: unknown, param: string) => { if (v === undefined) return undefined; const t = Date.parse(String(v)); if (Number.isNaN(t)) throw invalid(param, `${param} must be an RFC 3339 date-time.`); return t; };
const currencyOf = (v: unknown) => (v === undefined ? account.records.reporting_currency : checkCurrency(v, "currency"));

app.get("/v1/records", h((req, res) => {
  const q = req.query as Record<string, string | undefined>;
  if (q.type && !(RECORD_TYPES as string[]).includes(q.type)) throw invalid("type", `type must be one of: ${RECORD_TYPES.join(", ")}.`);
  if (q.chain && !EXPLORERS[q.chain]) throw invalid("chain", `Unknown chain ${q.chain}.`);
  const currency = currencyOf(q.currency);
  const recs = filterRecords(store.records, { type: q.type, asset: q.asset, chain: q.chain, invoice_id: q.invoice_id, order_id: q.order_id, tx_hash: q.tx_hash, gte: when(q.occurred_gte, "occurred_gte"), lte: when(q.occurred_lte, "occurred_lte"), includeSimulated: flag(q.include_simulated, "include_simulated") });
  const page = paginate(recs, q, (r) => r.occurred_at);
  res.json({ ...page, data: page.data.map((r) => revalue(r, currency)) });
}));
app.get("/v1/records/summary", h((req, res) => {
  const q = req.query as Record<string, string | undefined>;
  if (!q.period_start) throw missing("period_start");
  if (!q.period_end) throw missing("period_end");
  const timezone = q.timezone ?? account.records.timezone;
  if (!isValidTimeZone(timezone)) throw invalid("timezone", `${timezone} is not an IANA time zone.`);
  if (q.group_by && !GROUP_BY.includes(q.group_by)) throw invalid("group_by", `group_by must be one of: ${GROUP_BY.join(", ")}.`);
  const start = parseBoundary(q.period_start, timezone, "period_start");
  const end = parseBoundary(q.period_end, timezone, "period_end");
  if (start >= end) throw invalid("period_end", "period_end must be after period_start.");
  res.json(buildSummary(filterRecords(store.records, { includeSimulated: flag(q.include_simulated, "include_simulated") }), { start, end, currency: currencyOf(q.currency), timezone, groupBy: q.group_by ?? null }));
}));
app.get("/v1/records/:id", h((req, res) => {
  const r = store.records.find((x) => x.id === req.params.id);
  if (!r) throw notFound("record", req.params.id, "record_id");
  res.json(revalue(r, currencyOf(req.query.currency)));
}));

// ----------------------------------------------------------------- routes: exports (built synchronously, so they are `ready` when created)
const FILE_SECRET = randomBytes(32);
const fileSig = (exportId: string, expires: number) => createHmac("sha256", FILE_SECRET).update(`${exportId}.${expires}`).digest("hex");
const getExport = (idv: string) => {
  const e = store.exports.get(idv);
  if (!e) throw notFound("export", idv, "export_id");
  if (e.status === "ready" && Date.parse(e.download_expires_at!) < Date.now()) { e.status = "expired"; e.download_url = null; store.exportFiles.delete(e.id); }
  return e;
};
function sendFile(res: Response, e: ExportObject, buf: Buffer) {
  res.status(200).set({ "Content-Type": e.file!.content_type, "Content-Length": String(buf.length), "Content-Disposition": `attachment; filename="${e.file!.name}"` }).end(buf);
}

app.post("/v1/exports", h(async (req, res) => {
  const body = req.body ?? {};
  const parsed = parseExportRequest(body, account.records);
  if (body.metadata !== undefined && (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata))) throw invalid("metadata", "metadata must be an object of strings.");
  const exportId = id("exp");
  const created = now();
  const file = await buildExportFile(store, exportId, parsed, account);
  const expires = Date.now() + retentionMs;
  const base = `${req.protocol}://${req.get("host")}`;
  const e: ExportObject = {
    id: exportId, object: "export", livemode: false, status: "ready", dataset: parsed.dataset, format: parsed.format, preset: parsed.preset, period: parsed.period, timezone: parsed.timezone, currency: parsed.currency,
    include_simulated: parsed.include_simulated, rows: file.rows, file: { name: file.name, content_type: file.content_type, bytes: file.data.length, sha256: createHash("sha256").update(file.data).digest("hex") },
    download_url: `${base}/v1/export-files/${exportId}?expires=${Math.floor(expires / 1000)}&sig=${fileSig(exportId, Math.floor(expires / 1000))}`,
    download_expires_at: new Date(expires).toISOString(), failure_reason: null, metadata: body.metadata ?? {}, created_at: created, completed_at: now(),
  };
  store.exports.set(e.id, e);
  store.exportFiles.set(e.id, file.data);
  await emit("export.ready", e);
  res.status(201).json(e);
}));
app.get("/v1/exports", h((req, res) => {
  let items = [...store.exports.values()];
  items.forEach((e) => getExport(e.id));
  if (req.query.status) items = items.filter((e) => e.status === req.query.status);
  if (req.query.dataset) items = items.filter((e) => e.dataset === req.query.dataset);
  res.json(paginate(items, req.query as Record<string, unknown>));
}));
app.get("/v1/exports/:id", h((req, res) => res.json(getExport(req.params.id))));
app.delete("/v1/exports/:id", h((req, res) => {
  const e = getExport(req.params.id);
  store.exports.delete(e.id); store.exportFiles.delete(e.id);
  res.json({ id: e.id, object: "export", deleted: true });
}));
/** The reference server streams the file (`200`); production redirects (`302`) to the signed `download_url`. */
app.get("/v1/exports/:id/download", h((req, res) => {
  const e = getExport(req.params.id);
  if (e.status !== "ready") {
    const why = { queued: "is still being built", processing: "is still being built", expired: "has expired; create it again", failed: `failed: ${e.failure_reason ?? "unknown error"}` }[e.status];
    throw new ApiError(409, "invalid_request_error", e.status === "expired" ? "export_expired" : e.status === "failed" ? "export_failed" : "export_not_ready", `Export ${e.id} ${why}.`);
  }
  sendFile(res, e, store.exportFiles.get(e.id)!);
}));
/** What `download_url` points at: no API key, the signature and expiry in the query string are the credential. */
app.get("/v1/export-files/:id", h((req, res) => {
  const e = store.exports.get(req.params.id);
  const expires = Number(req.query.expires);
  const sig = Buffer.from(String(req.query.sig ?? ""), "hex");
  const want = Buffer.from(fileSig(req.params.id, expires), "hex");
  if (!e || !(expires * 1000 > Date.now()) || sig.length !== want.length || !timingSafeEqual(sig, want)) throw new ApiError(403, "permission_error", "invalid_signature", "The download link is invalid or has expired.");
  const buf = store.exportFiles.get(e.id);
  if (!buf) throw new ApiError(404, "invalid_request_error", "resource_missing", "The file is gone.");
  sendFile(res, e, buf);
}));

// ----------------------------------------------------------------- routes: test
app.post("/v1/test/simulate_payment", h(async (req, res) => {
  const b = req.body ?? {};
  if (!b.invoice_id) throw missing("invoice_id");
  const target: Invoice | CreditPurchase | undefined = store.invoices.get(b.invoice_id) ?? store.purchases.get(b.invoice_id);
  if (!target) throw notFound("invoice", b.invoice_id, "invoice_id");
  const payable: Payable = target.object === "invoice" ? target : target.payment;
  if (target.object === "invoice") expireIfDue(target);
  if (["cancelled", "refund_requested"].includes(payable.status) || (target.object === "credit_purchase" && target.status === "cancelled")) throw invalidState(`${target.id} is ${payable.status}.`);
  const asset = b.asset ?? payable.payment_options[0]?.asset;
  const opt = payable.payment_options.find((o) => o.asset === asset);
  if (!opt) throw invalid("asset", `${asset} is not a payment option on ${target.id}.`);

  const amount = b.amount ? String(b.amount) : opt.amount;
  const minor = toMinor(amount, opt.decimals);
  const confirmations = Math.max(0, Number(b.confirmations ?? 0));
  const existing = b.tx_hash ? [...store.payments.values()].find((p) => p.tx_hash === b.tx_hash && p.invoice_id === target.id) : undefined;

  let payment: Payment;
  const payStatus = confirmations >= opt.required_confirmations ? "confirmed" : confirmations > 0 ? "confirming" : "detected";
  if (existing) {
    existing.confirmations = confirmations; existing.status = payStatus; existing.updated_at = now();
    if (payStatus === "confirmed" && !existing.confirmed_at) existing.confirmed_at = now();
    if (confirmations > 0 && !existing.block_height) { existing.block_height = 4_800_000 + Math.floor(Math.random() * 1000); existing.block_hash = fakeTxHash(opt.chain); }
    payment = existing;
  } else {
    payment = {
      id: id("pay"), object: "payment", livemode: false, invoice_id: target.id, asset, chain: opt.chain, tx_hash: b.tx_hash ?? fakeTxHash(opt.chain), tx_index: 0,
      from_address: b.from_address ?? fakeAddress(opt.chain), to_address: opt.address, amount: fromMinor(minor, opt.decimals), amount_minor: minor.toString(),
      amount_fiat: (Number(fromMinor(minor, opt.decimals)) * Number(opt.rate)).toFixed(2), status: payStatus, confirmations, required_confirmations: opt.required_confirmations,
      block_height: confirmations > 0 ? 4_800_000 + Math.floor(Math.random() * 1000) : null, block_hash: confirmations > 0 ? fakeTxHash(opt.chain) : null,
      simulated: true, detected_at: now(), confirmed_at: payStatus === "confirmed" ? now() : null, created_at: now(), updated_at: now(),
    };
    store.payments.set(payment.id, payment);
  }

  const run = async () => {
    const all = [...store.payments.values()].filter((p) => p.invoice_id === target.id);
    const { status, prev } = applyPayment(payable, all, asset);
    if (target.object === "invoice") for (const p of all) recordPaymentReceived(store, p, target);
    if (target.object === "credit_purchase") { target.status = status; target.payment.payment_ids = payable.paid?.payment_ids ?? []; target.updated_at = now(); } else target.updated_at = now();

    await emit(existing ? (payStatus === "confirmed" ? "payment.confirmed" : "payment.detected") : "payment.detected", payment, { invoice_status: status });
    if (payStatus === "confirmed" && !existing) await emit("payment.confirmed", payment, { invoice_status: status });

    if (status !== prev) {
      if (target.object === "invoice") {
        const t = invoiceStatusEvents(status); if (t) await emit(t, target, {}, { status: prev });
        if (["paid", "underpaid", "overpaid"].includes(status) && !target.fee) {
          // canonical rule: clamp(round(fiat_usd x 30 bps / $0.01), 2, 2000) on the amount actually received
          const received = target.paid!;
          const opt = target.payment_options.find((o) => o.asset === received.asset)!;
          const fiatUsd = target.pricing === "fiat"
            ? Number(received.amount_received_fiat) * (FIAT_RATES_USD[target.currency] ?? 1)
            : Number(received.amount_received) * (ASSETS.find((a) => a.id === opt.asset)?.rate_usd ?? 0);
          // The balance never goes below zero: a payment larger than what was reserved is charged at most what is held.
          const credits = Math.min(creditsForUsd(fiatUsd), store.credits.balance);
          const entry = credits > 0 ? store.addLedger("debit", target.checkout_session_id ? "checkout_fee" : "invoice_fee", credits, { id: target.id, object: "invoice" }, `Invoice ${target.order_id ?? target.id}: $${fiatUsd.toFixed(2)} x ${FEE_BPS} bps`) : null;
          target.fee = { credits, bps: FEE_BPS, fiat_value_usd: fiatUsd.toFixed(2), ledger_entry_id: entry?.id ?? null };
          store.reservations.delete(target.id);
          if (entry) recordFee(store, entry, target);
        }
        if (["underpaid", "overpaid"].includes(status)) target.refund_claim_url = `${PAY_BASE}/i/${target.id}/refund`;
        if (target.checkout_session_id) syncSession(store.checkoutSessions.get(target.checkout_session_id)!);
      } else {
        const map: Record<string, string> = { paid: "credits.purchase.paid", overpaid: "credits.purchase.paid", underpaid: "credits.purchase.underpaid", expired: "credits.purchase.expired" };
        if (map[status]) await emit(map[status], target, {}, { status: prev });
        if (status === "paid" || status === "overpaid") {
          const bundle = store.bundles.find((x) => x.id === target.bundle_id)!;
          const entry = store.addLedger("credit", "purchase", target.credits, { id: target.id, object: "credit_purchase" }, `${bundle.name} bundle (${bundle.credits.toLocaleString("en-US")} credits${bundle.bonus_credits ? ` + ${bundle.bonus_credits} bonus` : ""})`);
          target.credits_added_at = now(); target.ledger_entry_id = entry.id;
          recordCreditPurchase(store, entry, target);
          await emit("credits.added", entry, { balance: balance() });
        }
      }
    }
  };

  const runAndNotify = async () => { await run(); notifyPublic(target.id); };
  const delay = Math.min(Math.max(Number(b.delay_seconds ?? 0), 0), 300);
  if (delay > 0) { setTimeout(() => void runAndNotify(), delay * 1000); return res.json({ payment, invoice: target, scheduled_in_seconds: delay }); }
  await runAndNotify();
  res.json({ payment, invoice: target });
}));

// ----------------------------------------------------------------- errors
app.use((_req, _res, next) => next(new ApiError(404, "invalid_request_error", "resource_missing", "Unrecognized request URL. See api/openapi.yaml.")));
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const requestId = String(res.getHeader("Request-Id"));
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { type: err.type, code: err.code, message: err.message, ...(err.param ? { param: err.param } : {}), request_id: requestId, ...(err.details ? { details: err.details } : {}) } });
  }
  if ((err as { type?: string }).type === "entity.parse.failed") return res.status(400).json({ error: { type: "invalid_request_error", code: "parameter_invalid", message: "Body is not valid JSON.", request_id: requestId } });
  console.error(err);
  res.status(500).json({ error: { type: "api_error", code: "internal_error", message: "Internal error in reference server.", request_id: requestId } });
});

if (process.env.NODE_ENV !== "test" && !process.env.NO_LISTEN) {
  app.listen(PORT, () => {
    console.log(`CoinVello reference server listening on http://localhost:${PORT}/v1`);
    console.log(`  Auth: any key starting with cv_test_   |  Webhook sink: POST http://localhost:${PORT}/v1/webhook-sink`);
  });
}
