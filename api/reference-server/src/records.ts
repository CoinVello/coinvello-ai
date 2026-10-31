/**
 * Records and exports for the mock (docs/10-records-and-tax.md, api/docs/records-and-exports.md).
 *
 * Records are written once, when their cause happens (payment confirmed, credits consumed, credits bought), and
 * stored in USD; reads re-value `value` from `value_usd` into the reporting currency. Everything on the reference
 * server originates from /test/simulate_payment, so every record is `simulated` and only shows with
 * `include_simulated=true`. Exports are built synchronously and come back `ready`.
 */
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { API_VERSION, ASSETS, DISPLAY_PER_USD, explorer, fromMinor, id, now, toMinor } from "./store.js";
import type { AccountingRecord, CreditPurchase, Invoice, InvoiceTax, LedgerEntry, Payment, RecordType, RecordValue, Store } from "./store.js";
import { ApiError } from "./errors.js";

/** The market value of a payment is this far under the invoice's locked rate, so `contract_value` and `value` differ. */
export const MARKET_SPREAD_BPS = 5;
const RETENTION_DAYS = 7;
const FIAT_CURRENCIES = new Set(["USD", "EUR", "GBP", "CAD", "AUD", "CHF", "JPY", "SEK", "NOK", "DKK", "PLN", "CZK", "BRL", "MXN", "INR", "SGD", "HKD", "NZD", "ZAR", "TRY", "AED"]);

export const RECORD_TYPES: RecordType[] = ["payment_received", "payment_reversed", "refund_sent", "fee_prepaid", "fee_onchain", "credit_purchase", "credit_adjustment", "conversion", "offramp_payout"];
export const EXPORT_DATASETS = ["records", "invoices", "payments", "refunds", "sweeps", "credit_ledger", "credit_purchases", "conversions", "offramp_payouts", "all"];
export const EXPORT_FORMATS = ["csv", "xlsx", "json"];
export const EXPORT_PRESETS = ["generic", "journal", "quickbooks", "xero", "koinly", "cointracker", "coinledger"];
export const GROUP_BY = ["month", "asset", "chain", "type", "address"];
const DATASET_LIST = EXPORT_DATASETS.filter((d) => d !== "all");

const bad = (param: string, msg: string, code = "parameter_invalid") => new ApiError(400, "invalid_request_error", code, msg, param);

// ----------------------------------------------------------------- money (USD pivot, integer cents for sums)
const perUsd = (cur: string) => DISPLAY_PER_USD[cur] ?? 1;
const cents = (s: string) => Number(toMinor(s, 2));
const fmt2 = (c: number) => fromMinor(BigInt(Math.round(c)), 2);
const round2 = (n: number) => fmt2(Math.round(n * 100));
/** `amount` of a fiat currency (ISO code) or of an asset id, in USD. */
const toUsd = (amount: number, cur: string) => (cur.includes(":") ? amount * (ASSETS.find((a) => a.id === cur)?.rate_usd ?? 0) : amount / perUsd(cur));
const convert = (amount: number, from: string, to: string) => toUsd(amount, from) * perUsd(to);
const symbolOf = (asset: string) => ASSETS.find((a) => a.id === asset)?.symbol ?? asset.split(":")[0].toUpperCase();

export function checkCurrency(value: unknown, param: string): string {
  const c = String(value).toUpperCase();
  if (!FIAT_CURRENCIES.has(c)) throw bad(param, `Unsupported currency ${c}.`, "currency_unsupported");
  return c;
}

// ----------------------------------------------------------------- time zones
const formats = new Map<string, Intl.DateTimeFormat>();
export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
function zoneParts(ms: number, tz: string): Record<string, number> {
  let f = formats.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); formats.set(tz, f); }
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o;
}
const offsetMinutes = (ms: number, tz: string) => {
  const p = zoneParts(ms, tz);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 60000);
};
/** `2026-03-05T14:22:10+01:00`: the instant as wall-clock time in `tz`, with its offset. */
export function isoInZone(ms: number, tz: string): string {
  const off = offsetMinutes(ms, tz);
  const a = Math.abs(off);
  return `${new Date(ms + off * 60000).toISOString().slice(0, 19)}${off < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
const utcSeconds = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";
const monthKey = (ms: number, tz: string) => isoInZone(ms, tz).slice(0, 7);

/** A date (`2026-01-01`, midnight in `tz`) or a date-time (with an offset, or wall-clock in `tz`) to epoch ms. */
export function parseBoundary(value: unknown, tz: string, param: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(String(value).trim());
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) throw bad(param, `${param} must be a date (2026-01-01) or an RFC 3339 date-time.`);
  if (m[7]) {
    const ms = Date.parse(String(value).trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (Number.isNaN(ms)) throw bad(param, `${param} is not a valid date-time.`);
    return ms;
  }
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  return guess - offsetMinutes(guess - offsetMinutes(guess, tz) * 60000, tz) * 60000;
}

// ----------------------------------------------------------------- writers (called where the cause happens)
const source = (provider: string): RecordValue["source"] => ({ provider, method: null, venues: [], snapshot_id: null });
const usdValue = (amount: string, rate: string | null, asOf: string, src: RecordValue["source"]): RecordValue => ({ currency: "USD", amount, rate, rate_as_of: asOf, source: src });

function blank(type: RecordType, occurredAt: string, description: string, value: RecordValue): AccountingRecord {
  return {
    id: id("rec"), object: "record", livemode: false, type, occurred_at: occurredAt, recorded_at: now(), description,
    received: null, sent: null, fee: null, chain: null, tx_hash: null, tx_index: null, block_height: null, from_address: null, to_address: null, derivation_path: null, explorer_url: null,
    contract_value: null, value, value_usd: value.amount, tax: null, credits: null, invoice: null, related: {}, reverses_record_id: null, flags: ["simulated"], simulated: true, metadata: {},
  };
}

const snapshot = (inv: Invoice): AccountingRecord["invoice"] => ({
  id: inv.id, status: inv.status, order_id: inv.order_id, description: inv.description, amount: inv.amount, currency: inv.currency, pricing: inv.pricing,
  checkout_session_id: inv.checkout_session_id, customer_reference: inv.customer?.reference ?? null,
});

/** Writes `payment_received` once per confirmed payment (the dedup key is the payment id). */
export function recordPaymentReceived(store: Store, p: Payment, inv: Invoice): void {
  const key = `${p.id}|payment_received`;
  if (p.status !== "confirmed" || store.recordKeys.has(key)) return;
  store.recordKeys.add(key);
  const asset = ASSETS.find((a) => a.id === p.asset)!;
  const opt = inv.payment_options.find((o) => o.asset === p.asset);
  const occurred = p.confirmed_at ?? p.updated_at;
  const marketRate = asset.rate_usd * (1 - MARKET_SPREAD_BPS / 10000);
  const valueUsd = round2(Number(p.amount) * marketRate);
  const r = blank("payment_received", occurred, `Payment for invoice ${inv.id}${inv.order_id ? ` (order ${inv.order_id})` : ""}`,
    usdValue(valueUsd, marketRate.toFixed(5), occurred, { provider: "coinvello_oracle", method: "median", venues: ["coinbase", "kraken", "binance"], snapshot_id: `rs_${p.id.slice(4)}` }));
  r.received = { asset: p.asset, amount: p.amount, amount_minor: p.amount_minor };
  Object.assign(r, { chain: p.chain, tx_hash: p.tx_hash, tx_index: p.tx_index, block_height: p.block_height, from_address: p.from_address, to_address: p.to_address, derivation_path: opt?.derivation_path ?? null, explorer_url: explorer(p.chain, "tx", p.tx_hash) });
  if (inv.pricing === "fiat") r.contract_value = { currency: inv.currency, amount: p.amount_fiat, rate: opt?.rate ?? null, rate_as_of: inv.created_at, source: { ...source("invoice_rate_lock"), snapshot_id: inv.rate_lock.id } };
  if (inv.tax) {
    // a part-payment carries its share of the tax; an overpayment never more than all of it
    const ratio = Math.min(1, Number(inv.pricing === "fiat" ? p.amount_fiat : p.amount) / Number(inv.amount));
    r.tax = { ...inv.tax, amount: round2(Number(inv.tax.amount) * ratio) };
  }
  r.invoice = snapshot(inv);
  r.related = { payment_id: p.id, invoice_id: inv.id };
  r.flags = [...(inv.status === "overpaid" ? ["overpaid"] : []), ...(inv.status === "underpaid" ? ["underpaid"] : []), ...(Date.parse(occurred) > Date.parse(inv.expires_at) ? ["late"] : []), "simulated"];
  r.metadata = inv.metadata;
  store.records.push(r);
}

/** Writes `fee_prepaid` for a credit-ledger debit; the value is the nominal $0.01 per credit. */
export function recordFee(store: Store, entry: LedgerEntry, inv: Invoice | undefined): void {
  const key = `${entry.id}|fee_prepaid`;
  if (store.recordKeys.has(key)) return;
  store.recordKeys.add(key);
  const r = blank("fee_prepaid", entry.created_at, entry.description ?? "CoinVello processing fee", usdValue(fmt2(entry.amount), "0.01000", entry.created_at, source("credits_nominal")));
  r.credits = entry.amount;
  if (inv) { r.invoice = snapshot(inv); r.metadata = inv.metadata; }
  r.related = { ledger_entry_id: entry.id, ...(inv ? { invoice_id: inv.id } : {}) };
  store.records.push(r);
}

/** Writes `credit_purchase` when the credits are added: `sent` is the crypto paid, `value` the price charged in USD. */
export function recordCreditPurchase(store: Store, entry: LedgerEntry, purchase: CreditPurchase): void {
  const key = `${purchase.id}|credit_purchase`;
  if (store.recordKeys.has(key)) return;
  store.recordKeys.add(key);
  const p = [...store.payments.values()].find((x) => x.invoice_id === purchase.id && x.status === "confirmed");
  const occurred = p?.confirmed_at ?? entry.created_at;
  const bundle = store.bundles.find((b) => b.id === purchase.bundle_id);
  const price = purchase.price.amount;
  const r = blank("credit_purchase", occurred, `Credit purchase: ${bundle?.name ?? purchase.bundle_id} bundle (${purchase.credits.toLocaleString("en-US")} credits)`,
    usdValue(price, null, occurred, source("invoice_rate_lock")));
  r.contract_value = usdValue(price, null, purchase.created_at, source("invoice_rate_lock"));
  r.credits = purchase.credits;
  if (p) {
    r.sent = { asset: p.asset, amount: p.amount, amount_minor: p.amount_minor };
    Object.assign(r, { chain: p.chain, tx_hash: p.tx_hash, tx_index: p.tx_index, block_height: p.block_height, from_address: p.from_address, to_address: p.to_address, explorer_url: explorer(p.chain, "tx", p.tx_hash) });
  }
  r.related = { credit_purchase_id: purchase.id, ledger_entry_id: entry.id, ...(p ? { payment_id: p.id } : {}) };
  r.metadata = purchase.metadata;
  store.records.push(r);
}

// ----------------------------------------------------------------- reads: re-valuation and filters
/** `value` in `currency`, derived from the stored USD value (`value_usd` and the original rate stay as they are). */
export function revalue(rec: AccountingRecord, currency: string): AccountingRecord {
  if (currency === "USD") return rec;
  const k = perUsd(currency);
  return { ...rec, value: { ...rec.value, currency, amount: round2(Number(rec.value_usd) * k), rate: rec.value.rate === null ? null : (Number(rec.value.rate) * k).toFixed(5) } };
}
const valueCents = (r: AccountingRecord, cur: string) => cents(cur === "USD" ? r.value_usd : round2(Number(r.value_usd) * perUsd(cur)));
const contractCents = (r: AccountingRecord, cur: string) => (r.contract_value ? Math.round(convert(Number(r.contract_value.amount), r.contract_value.currency, cur) * 100) : null);
const taxCents = (r: AccountingRecord, cur: string) => (r.tax ? Math.round(convert(Number(r.tax.amount), r.invoice?.currency ?? "USD", cur) * 100) : 0);
const feeCents = (r: AccountingRecord, cur: string) => (r.fee ? Math.round(convert(Number(r.fee.amount), r.fee.asset, cur) * 100) : 0);

export interface RecordFilter { type?: string; asset?: string; chain?: string; invoice_id?: string; order_id?: string; tx_hash?: string; gte?: number; lte?: number; includeSimulated: boolean }
export function filterRecords(recs: AccountingRecord[], f: RecordFilter): AccountingRecord[] {
  return recs.filter((r) => {
    if (r.simulated && !f.includeSimulated) return false;
    if (f.type && r.type !== f.type) return false;
    if (f.asset && ![r.received, r.sent, r.fee].some((l) => l?.asset === f.asset)) return false;
    if (f.chain && r.chain !== f.chain) return false;
    if (f.invoice_id && (r.invoice?.id ?? r.related.invoice_id) !== f.invoice_id) return false;
    if (f.order_id && r.invoice?.order_id !== f.order_id) return false;
    if (f.tx_hash && r.tx_hash !== f.tx_hash) return false;
    const t = Date.parse(r.occurred_at);
    return (f.gte === undefined || t >= f.gte) && (f.lte === undefined || t <= f.lte);
  });
}

// ----------------------------------------------------------------- summary (design §5)
const merchantAddress = (r: AccountingRecord) => (r.type === "payment_received" || r.type === "conversion" ? r.to_address : r.from_address);
function groupKey(r: AccountingRecord, by: string, tz: string): string | null {
  switch (by) {
    case "month": return monthKey(Date.parse(r.occurred_at), tz);
    case "asset": return (r.received ?? r.sent ?? r.fee)?.asset ?? null;
    case "chain": return r.chain;
    case "type": return r.type;
    default: return merchantAddress(r);
  }
}

export function totals(recs: AccountingRecord[], cur: string) {
  let paymentsCount = 0, refundsCount = 0, sales = 0, tax = 0, received = 0, refunds = 0, feesPrepaid = 0, credits = 0, feesOnchain = 0, network = 0, purchases = 0;
  const invoices = new Set<string>();
  for (const r of recs) {
    const v = valueCents(r, cur);
    if (r.type === "payment_received" || r.type === "payment_reversed") {
      const sign = r.type === "payment_received" ? 1 : -1;
      paymentsCount += sign; received += sign * Math.abs(v);
      sales += sign * Math.abs(contractCents(r, cur) ?? v);
      tax += sign * Math.abs(taxCents(r, cur));
      if (sign > 0 && r.invoice && ["paid", "overpaid", "underpaid"].includes(r.invoice.status)) invoices.add(r.invoice.id);
    } else if (r.type === "refund_sent") { refundsCount++; refunds += Math.abs(v); }
    else if (r.type === "fee_prepaid") { feesPrepaid += v; credits += r.credits ?? 0; }
    else if (r.type === "fee_onchain") feesOnchain += v;
    else if (r.type === "credit_purchase") purchases += v;
    network += feeCents(r, cur);
  }
  return {
    payments_count: paymentsCount, invoices_paid: invoices.size, refunds_count: refundsCount,
    sales: fmt2(sales), tax_collected: fmt2(tax), received_market_value: fmt2(received), valuation_difference: fmt2(received - sales),
    refunds: fmt2(refunds), fees_prepaid: fmt2(feesPrepaid), credits_consumed: credits, fees_onchain: fmt2(feesOnchain), network_fees: fmt2(network),
    credit_purchases: fmt2(purchases), net_received: fmt2(received - refunds - feesOnchain - network),
  };
}

export function buildSummary(recs: AccountingRecord[], o: { start: number; end: number; currency: string; timezone: string; groupBy: string | null }) {
  const inRange = recs.filter((r) => { const t = Date.parse(r.occurred_at); return t >= o.start && t < o.end; });
  const out: Record<string, unknown> = {
    object: "records_summary", livemode: false, period: { start: new Date(o.start).toISOString(), end: new Date(o.end).toISOString() }, currency: o.currency, timezone: o.timezone,
    group_by: o.groupBy, ...totals(inRange, o.currency),
  };
  if (o.groupBy) {
    const groups = new Map<string, AccountingRecord[]>();
    for (const r of inRange) { const k = groupKey(r, o.groupBy, o.timezone); if (k) groups.set(k, [...(groups.get(k) ?? []), r]); }
    out.groups = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, rs]) => ({ key, ...totals(rs, o.currency) }));
  }
  return out;
}

// ----------------------------------------------------------------- export tables
interface Ctx { currency: string; timezone: string }
interface Table { columns: string[]; rows: Array<Record<string, string>> }
type Cell = string | number;

/** Design §4.3, in this order. */
export const GENERIC_COLUMNS = `record_id, type, flags, occurred_at, occurred_at_utc, recorded_at_utc, description,
  invoice_id, invoice_status, order_id, checkout_session_id, customer_reference, invoice_amount, invoice_currency,
  received_asset, received_amount, received_amount_minor, sent_asset, sent_amount, sent_amount_minor,
  fee_asset, fee_amount,
  chain, tx_hash, tx_index, block_height, from_address, to_address, derivation_path, explorer_url,
  contract_currency, contract_amount, contract_rate,
  value_currency, value_amount, value_rate, value_rate_as_of, value_source, value_snapshot_id, value_usd,
  tax_amount, tax_rate, tax_label, tax_jurisdiction,
  credits, related_ids, reverses_record_id, livemode, simulated, metadata_json`.split(/[\s,]+/);

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function genericRow(rec: AccountingRecord, c: Ctx): Record<string, string> {
  const r = revalue(rec, c.currency);
  const t = Date.parse(r.occurred_at);
  return {
    record_id: r.id, type: r.type, flags: r.flags.join(";"), occurred_at: isoInZone(t, c.timezone), occurred_at_utc: utcSeconds(t), recorded_at_utc: utcSeconds(Date.parse(r.recorded_at)), description: r.description,
    invoice_id: s(r.invoice?.id), invoice_status: s(r.invoice?.status), order_id: s(r.invoice?.order_id), checkout_session_id: s(r.invoice?.checkout_session_id), customer_reference: s(r.invoice?.customer_reference),
    invoice_amount: s(r.invoice?.amount), invoice_currency: s(r.invoice?.currency),
    received_asset: s(r.received?.asset), received_amount: s(r.received?.amount), received_amount_minor: s(r.received?.amount_minor),
    sent_asset: s(r.sent?.asset), sent_amount: s(r.sent?.amount), sent_amount_minor: s(r.sent?.amount_minor),
    fee_asset: s(r.fee?.asset), fee_amount: s(r.fee?.amount),
    chain: s(r.chain), tx_hash: s(r.tx_hash), tx_index: s(r.tx_index), block_height: s(r.block_height), from_address: s(r.from_address), to_address: s(r.to_address), derivation_path: s(r.derivation_path), explorer_url: s(r.explorer_url),
    contract_currency: s(r.contract_value?.currency), contract_amount: s(r.contract_value?.amount), contract_rate: s(r.contract_value?.rate),
    value_currency: r.value.currency, value_amount: r.value.amount, value_rate: s(r.value.rate), value_rate_as_of: s(r.value.rate_as_of), value_source: r.value.source.provider, value_snapshot_id: s(r.value.source.snapshot_id), value_usd: r.value_usd,
    tax_amount: s(r.tax?.amount), tax_rate: s(r.tax?.rate), tax_label: s(r.tax?.label), tax_jurisdiction: s(r.tax?.jurisdiction),
    credits: s(r.credits), related_ids: Object.entries(r.related).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(";"), reverses_record_id: s(r.reverses_record_id),
    livemode: String(r.livemode), simulated: String(r.simulated), metadata_json: JSON.stringify(r.metadata ?? {}),
  };
}

// --- presets: a pure column mapping over the record (design §4.4); the vendor headers must be re-verified before they ship
const symbol = (leg: { asset: string } | null) => (leg ? symbolOf(leg.asset) : "");
const dmy = (ms: number, tz: string, fmt: "us" | "eu") => { const d = isoInZone(ms, tz); const [y, m, dd] = d.slice(0, 10).split("-"); return fmt === "us" ? `${m}/${dd}/${y}` : `${dd}/${m}/${y}`; };
const stamp = (ms: number) => utcSeconds(ms).replace("T", " ").replace("Z", "");
const money = (c: number) => fmt2(c);
/** Signed cash effect on the wallet side for the bank-feed presets; non-cash credit adjustments and conversions are left out. */
function bankSign(type: RecordType): number {
  if (type === "payment_received") return 1;
  if (["payment_reversed", "refund_sent", "fee_prepaid", "fee_onchain", "credit_purchase", "offramp_payout"].includes(type)) return -1;
  return 0;
}
function bankDescription(r: AccountingRecord): string {
  const leg = r.received ?? r.sent;
  const parts = ["CoinVello", r.invoice?.id ?? s(r.related.credit_purchase_id), r.invoice?.order_id ? `Order ${r.invoice.order_id}` : "",
    r.credits !== null && !leg ? `${r.credits} credits` : leg ? `${leg.amount} ${symbol(leg)}${r.value.rate ? ` @ ${r.value.rate} ${r.value.currency}` : ""}` : r.type, r.tx_hash ? `tx ${r.tx_hash}` : ""];
  return parts.filter(Boolean).join(" · ");
}

function journalLines(r: AccountingRecord, cur: string): Array<{ account: string; debit: number; credit: number }> {
  const v = Math.abs(valueCents(r, cur));
  const fee = Math.abs(feeCents(r, cur));
  const asset = (leg: { asset: string } | null) => (leg && leg.asset.includes(":") ? `Digital assets - ${symbol(leg)}` : "Card / bank");
  const lines: Array<{ account: string; debit: number; credit: number }> = [];
  const dr = (account: string, n: number) => n && lines.push({ account, debit: n, credit: 0 });
  const cr = (account: string, n: number) => n && lines.push({ account, debit: 0, credit: n });
  switch (r.type) {
    case "payment_received": case "payment_reversed": {
      const contract = Math.abs(contractCents(r, cur) ?? v);
      const tax = Math.min(contract, Math.abs(taxCents(r, cur)));
      dr(asset(r.received ?? r.sent), v); cr("Sales", contract - tax); cr("Sales tax payable", tax);
      if (v > contract) cr("Valuation difference on receipt", v - contract); else dr("Valuation difference on receipt", contract - v);
      if (r.type === "payment_reversed") return lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit }));
      break;
    }
    case "refund_sent": dr("Sales returns and refunds", v); dr("Network fees", fee); cr(asset(r.sent), v + fee); break;
    case "fee_prepaid": dr("Processing fees", v); cr("Prepaid processing credits", v); break;
    case "fee_onchain": dr("Processing fees", v); dr("Network fees", fee); cr(asset(r.sent), v + fee); break;
    case "credit_purchase": dr("Prepaid processing credits", v); cr(asset(r.sent), v); break;
    case "conversion": dr(asset(r.received), v); dr("Network fees", fee); cr(asset(r.sent), v + fee); break;
    case "offramp_payout": dr(`Bank - ${r.sent?.asset ?? "partner"}`, v); cr(asset(r.sent), v); break;
    default: lines.push({ account: "Prepaid processing credits", debit: 0, credit: 0 }); // credit_adjustment: memo only
  }
  return lines;
}

function presetTable(recs: AccountingRecord[], preset: string, c: Ctx): Table {
  const rows: Array<Record<string, string>> = [];
  const { currency: cur, timezone: tz } = c;
  let columns: string[];
  switch (preset) {
    case "journal":
      columns = ["date", "journal_no", "account", "debit", "credit", "currency", "memo", "record_id", "tx_hash"];
      recs.forEach((r, i) => {
        const disposal = ["refund_sent", "conversion", "offramp_payout", "fee_onchain"].includes(r.type);
        for (const l of journalLines(r, cur)) rows.push({
          date: isoInZone(Date.parse(r.occurred_at), tz).slice(0, 10), journal_no: `J-${String(i + 1).padStart(5, "0")}`, account: l.account,
          debit: l.debit ? money(l.debit) : "", credit: l.credit ? money(l.credit) : "", currency: cur,
          memo: `${r.description}${r.type === "credit_adjustment" ? " (non-cash)" : ""}${disposal ? " - gain or loss on the disposal is not posted; compute it in your tax tool" : ""}`, record_id: r.id, tx_hash: s(r.tx_hash),
        });
      });
      break;
    case "quickbooks":
      columns = ["Date", "Description", "Amount"];
      for (const r of recs) if (bankSign(r.type)) rows.push({ Date: dmy(Date.parse(r.occurred_at), tz, "us"), Description: bankDescription(r), Amount: money(bankSign(r.type) * Math.abs(valueCents(r, cur))) });
      break;
    case "xero":
      columns = ["Date", "Amount", "Payee", "Description", "Reference"];
      for (const r of recs) if (bankSign(r.type)) rows.push({
        Date: dmy(Date.parse(r.occurred_at), tz, "eu"), Amount: money(bankSign(r.type) * Math.abs(valueCents(r, cur))), Payee: r.invoice?.customer_reference || "CoinVello payer",
        Description: bankDescription(r), Reference: [r.invoice?.id, r.invoice?.order_id].filter(Boolean).join(" · "),
      });
      break;
    case "koinly":
      columns = ["Date", "Sent Amount", "Sent Currency", "Received Amount", "Received Currency", "Fee Amount", "Fee Currency", "Net Worth Amount", "Net Worth Currency", "Label", "Description", "TxHash"];
      for (const r of recs) {
        if (!cryptoMovement(r)) continue;
        rows.push({
          Date: stamp(Date.parse(r.occurred_at)), "Sent Amount": s(r.sent?.amount), "Sent Currency": symbol(r.sent), "Received Amount": s(r.received?.amount), "Received Currency": symbol(r.received),
          "Fee Amount": s(r.fee?.amount), "Fee Currency": symbol(r.fee), "Net Worth Amount": money(Math.abs(valueCents(r, cur))), "Net Worth Currency": cur,
          Label: r.type === "payment_received" ? "income" : ["fee_onchain", "credit_purchase"].includes(r.type) ? "cost" : "", Description: `${r.type} via CoinVello (${s(r.chain)})`, TxHash: s(r.tx_hash),
        });
      }
      break;
    case "cointracker":
      columns = ["Date", "Received Quantity", "Received Currency", "Sent Quantity", "Sent Currency", "Fee Amount", "Fee Currency", "Tag"];
      for (const r of recs) if (cryptoMovement(r)) {
        const t = Date.parse(r.occurred_at);
        const [d, tm] = stamp(t).split(" ");
        rows.push({ Date: `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)} ${tm}`, "Received Quantity": s(r.received?.amount), "Received Currency": symbol(r.received), "Sent Quantity": s(r.sent?.amount), "Sent Currency": symbol(r.sent), "Fee Amount": s(r.fee?.amount), "Fee Currency": symbol(r.fee), Tag: r.type === "payment_received" ? "payment" : "" });
      }
      break;
    default: // coinledger
      columns = ["Date (UTC)", "Platform (Optional)", "Asset Sent", "Amount Sent", "Asset Received", "Amount Received", "Fee Currency (Optional)", "Fee Amount (Optional)", "Type", "Description (Optional)", "TxHash (Optional)"];
      for (const r of recs) if (cryptoMovement(r)) rows.push({
        "Date (UTC)": stamp(Date.parse(r.occurred_at)), "Platform (Optional)": "CoinVello", "Asset Sent": symbol(r.sent), "Amount Sent": s(r.sent?.amount), "Asset Received": symbol(r.received), "Amount Received": s(r.received?.amount),
        "Fee Currency (Optional)": symbol(r.fee), "Fee Amount (Optional)": s(r.fee?.amount),
        Type: r.type === "payment_received" ? "Income" : r.type === "conversion" ? "Trade" : r.type === "refund_sent" || r.type === "offramp_payout" ? "Withdrawal" : "Fee", "Description (Optional)": `${r.type} via CoinVello (${s(r.chain)})`, "TxHash (Optional)": s(r.tx_hash),
      });
  }
  return { columns, rows };
}
/** The crypto-tax presets list real coin movements only: not card purchases, prepaid-credit consumption or adjustments. */
const cryptoMovement = (r: AccountingRecord) => !["fee_prepaid", "credit_adjustment", "payment_reversed"].includes(r.type) && !!(r.received ?? r.sent)?.asset.includes(":");

// --- the other datasets: the API objects flattened (nested objects -> parent_child columns, arrays -> `;`-joined or JSON)
function flatten(v: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (x === null || x === undefined) out[key] = "";
    else if (Array.isArray(x)) out[key] = x.every((y) => typeof y !== "object" || y === null) ? x.join(";") : JSON.stringify(x);
    else if (typeof x === "object") { if (Object.keys(x).length) flatten(x, key, out); else out[key] = ""; }
    else out[key] = String(x);
  }
  return out;
}
const HEAVY = new Set(["payment_options", "rate_lock", "required_confirmations"]);
const lean = (v: unknown): unknown => (Array.isArray(v) ? v.map(lean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !HEAVY.has(k)).map(([k, x]) => [k, lean(x)])) : v);
/** Customer details are never exported: only the merchant's own `customer.reference` survives. */
const withoutCustomer = (inv: Invoice) => { const { customer, ...rest } = inv; return { ...rest, customer: customer?.reference ? { reference: customer.reference } : null }; };
const SKELETON: Record<string, string[]> = {
  refunds: ["id", "object", "livemode", "status", "invoice_id", "payment_id", "asset", "chain", "amount", "tx_hash", "created_at", "completed_at"],
  sweeps: ["id", "object", "livemode", "receiver_id", "chain", "asset", "amount", "fee", "network_fee", "tx_hash", "status", "created_at", "confirmed_at"],
  conversions: ["id", "object", "livemode", "status", "from_asset", "to_asset", "from_amount", "to_amount_received", "created_at", "completed_at"],
  offramp_payouts: ["id", "object", "livemode", "status", "asset", "amount", "fiat_currency", "fiat_amount_paid", "created_at", "completed_at"],
};

interface Data { objects: unknown[]; table: Table }
interface Req { dataset: string; format: string; preset: string; period: { start: string; end: string } | null; timezone: string; currency: string; include_simulated: boolean }

function datasetData(store: Store, dataset: string, req: Req, range: { start: number; end: number } | null): Data {
  const within = (iso: string) => !range || (Date.parse(iso) >= range.start && Date.parse(iso) < range.end);
  const ctx = { currency: req.currency, timezone: req.timezone };
  let objects: unknown[] = [];
  let flat: unknown[] | null = null;
  switch (dataset) {
    case "records": {
      const recs = filterRecords(store.records, { includeSimulated: req.include_simulated, gte: range?.start, lte: range ? range.end - 1 : undefined })
        .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : a.id < b.id ? -1 : 1));
      objects = recs.map((r) => revalue(r, req.currency));
      const table: Table = req.preset === "generic" ? { columns: GENERIC_COLUMNS, rows: recs.map((r) => genericRow(r, ctx)) } : presetTable(recs, req.preset, ctx);
      return { objects, table };
    }
    case "invoices": objects = [...store.invoices.values()].filter((i) => within(i.created_at)).map(withoutCustomer); break;
    case "payments": objects = [...store.payments.values()].filter((p) => p.invoice_id.startsWith("inv_") && within(p.created_at) && (req.include_simulated || !p.simulated)); break;
    case "credit_ledger": objects = [...store.ledger].reverse().filter((l) => within(l.created_at)); break;
    case "credit_purchases": objects = [...store.purchases.values()].filter((p) => within(p.created_at)); break;
    default: break; // refunds, sweeps, conversions, offramp_payouts: the mock has none
  }
  flat = (objects as Array<Record<string, unknown>>).map((o) => flatten(lean(o)));
  const columns = flat.length ? [...new Set((flat as Array<Record<string, string>>).flatMap((o) => Object.keys(o)))] : SKELETON[dataset] ?? ["id", "object"];
  return { objects, table: { columns, rows: flat as Array<Record<string, string>> } };
}

// ----------------------------------------------------------------- file writers
const BOM = "﻿";
/** RFC 4180, LF line ends; text that starts like a formula gets a leading apostrophe (CSV injection), plain negative numbers are left alone. */
function csvCell(v: string): string {
  const x = /^[=+@\t\r]/.test(v) || (v.startsWith("-") && !/^-\d+(\.\d+)?$/.test(v)) ? `'${v}` : v;
  return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
}
export const renderCsv = (t: Table) => BOM + [t.columns.map(csvCell).join(","), ...t.rows.map((r) => t.columns.map((c) => csvCell(r[c] ?? "")).join(","))].join("\n") + "\n";
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const FIAT_COLUMNS = new Set(["invoice_amount", "contract_amount", "value_amount", "value_usd", "tax_amount"]);
const INT_COLUMNS = new Set(["credits", "tx_index", "block_height"]);
const SHEET_NAMES: Record<string, string> = { records: "Records", invoices: "Invoices", payments: "Payments", refunds: "Refunds", sweeps: "Sweeps", credit_ledger: "Credit ledger", credit_purchases: "Credit purchases", conversions: "Conversions", offramp_payouts: "Off-ramp payouts" };
const DISCLAIMER = "CoinVello is not a tax or accounting adviser. These records are the facts CoinVello observed on public blockchains and in your account, valued at the rates shown. How they are taxed depends on where you are and how you keep your books; check them with your adviser and verify any row on a block explorer.";

function addSheet(wb: ExcelJS.Workbook, name: string, dataset: string, t: Table, c: Ctx): void {
  const ws = wb.addWorksheet(name);
  const typed = dataset === "records" ? t.columns : [];
  const cols: string[] = [];
  for (const col of t.columns) { cols.push(col); if (typed.length && col === "occurred_at") cols.push("occurred_at_iso"); }
  ws.columns = cols.map((key) => ({ header: key, key, width: Math.min(48, Math.max(12, key.length + 2)) }));
  for (const row of t.rows) {
    const out: Record<string, Cell | Date | null> = {};
    for (const col of cols) {
      const raw = col === "occurred_at_iso" ? row.occurred_at : row[col] ?? "";
      if (col === "occurred_at" && typed.length) out[col] = new Date(raw.slice(0, 19) + "Z"); // wall-clock time in the export timezone
      else if (typed.length && raw !== "" && (FIAT_COLUMNS.has(col) || INT_COLUMNS.has(col)) && !(col === "invoice_amount" && row.invoice_currency.includes(":"))) out[col] = Number(raw);
      else out[col] = raw === "" ? null : raw;
    }
    ws.addRow(out);
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  if (cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  cols.forEach((key, i) => {
    const col = ws.getColumn(i + 1);
    if (key === "occurred_at" && typed.length) col.numFmt = "yyyy-mm-dd hh:mm:ss";
    else if (typed.length && FIAT_COLUMNS.has(key)) col.numFmt = "0.00";
  });
  void c;
}

function readme(req: Req, account: { id: string; business_name: string | null }, exportId: string, rows: number, csvSha: string, range: { start: number; end: number } | null): Array<[string, string]> {
  return [
    ["CoinVello export", exportId], ["Account", account.id], ["Business name", account.business_name ?? ""], ["Mode", "test"],
    ["Dataset", req.dataset], ["Period", req.period ? `${req.period.start} to ${req.period.end} (end exclusive)` : "entire history"],
    ["Period (UTC)", range ? `${utcSeconds(range.start)} to ${utcSeconds(range.end)}` : "all time"],
    ["Timezone", req.timezone], ["Currency", req.currency], ["Generated at", utcSeconds(Date.now())], ["API version", API_VERSION], ["Rows", String(rows)],
    ["SHA-256 of the CSV-equivalent rows", csvSha],
    ["Simulated rows", req.include_simulated ? "included (reference server / test mode)" : "excluded"],
    ["Valuation", "`value` is the market value at the block time in the currency above, derived from `value_usd`; `contract_value` is what the customer owed at the invoice's locked rate. Both are kept; the Summary sheet reports both and their difference."],
    ["Columns", "See docs/10-records-and-tax.md section 4.3 (generic records columns). Fiat values are numbers; crypto amounts, hashes and ids are text."],
    ["Notice", DISCLAIMER],
  ];
}

async function workbook(store: Store, req: Req, datasets: string[], data: Map<string, Data>, range: { start: number; end: number } | null, account: { id: string; business_name: string | null }, exportId: string, rows: number, csvSha: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CoinVello"; wb.created = new Date();
  const info = wb.addWorksheet("Read me");
  info.columns = [{ width: 36 }, { width: 110 }];
  for (const [k, v] of readme(req, account, exportId, rows, csvSha, range)) { const row = info.addRow([k, v]); row.getCell(1).font = { bold: true }; row.getCell(2).alignment = { wrapText: true, vertical: "top" }; }
  const sum = wb.addWorksheet("Summary");
  sum.columns = [{ width: 30 }, { width: 22 }, { width: 22 }, { width: 22 }, { width: 22 }, { width: 22 }];
  const all = filterRecords(store.records, { includeSimulated: req.include_simulated });
  const start = range?.start ?? Date.parse(all.reduce((a, r) => (r.occurred_at < a ? r.occurred_at : a), now()));
  const end = range?.end ?? Date.now() + 1000;
  const addTable = (title: string, t: Record<string, unknown>[]) => {
    sum.addRow([title]).font = { bold: true };
    if (!t.length) { sum.addRow(["(none)"]); sum.addRow([]); return; }
    const keys = Object.keys(t[0]);
    sum.addRow(keys).font = { bold: true };
    for (const o of t) { const row = sum.addRow(keys.map((k) => (typeof o[k] === "string" && /^-?\d+\.\d+$/.test(o[k] as string) ? Number(o[k]) : o[k]))); row.eachCell((cell) => { if (typeof cell.value === "number" && !Number.isInteger(cell.value)) cell.numFmt = "0.00"; }); }
    sum.addRow([]);
  };
  const base = buildSummary(all, { start, end, currency: req.currency, timezone: req.timezone, groupBy: null });
  const { object: _o, livemode: _l, period: _p, currency: _c, timezone: _t, group_by: _g, ...tot } = base;
  addTable(`Totals (${req.currency}, ${req.timezone})`, Object.entries(tot).map(([total, value]) => ({ total, value })));
  for (const by of ["month", "asset"]) addTable(`By ${by}`, ((buildSummary(all, { start, end, currency: req.currency, timezone: req.timezone, groupBy: by }).groups as Array<Record<string, unknown>>) ?? []).map(({ key, ...rest }) => ({ [by]: key, ...rest })));
  sum.addRow([DISCLAIMER]);
  for (const ds of datasets) addSheet(wb, SHEET_NAMES[ds], ds, data.get(ds)!.table, { currency: req.currency, timezone: req.timezone });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- a stored (uncompressed) zip, enough for the `all` package in csv and json
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(files: Array<{ name: string; data: Buffer }>): Buffer {
  const d = new Date();
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  const chunks: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name); const crc = crc32(f.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(f.data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(f.data.length, 20); cd.writeUInt32LE(f.data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    chunks.push(local, name, f.data); central.push(cd, name); offset += 30 + name.length + f.data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

// ----------------------------------------------------------------- export requests
/** 400 for a malformed field, 422 when the preset does not fit the dataset or format. */
export function parseExportRequest(body: Record<string, any>, settings: { reporting_currency: string; timezone: string }): Req {
  const oneOf = (field: string, allowed: string[], dflt?: string) => {
    const v = body[field] ?? dflt;
    if (v === undefined) throw new ApiError(400, "invalid_request_error", "parameter_missing", `${field} is required.`, field);
    if (!allowed.includes(String(v))) throw bad(field, `${field} must be one of: ${allowed.join(", ")}.`);
    return String(v);
  };
  const format = oneOf("format", EXPORT_FORMATS);
  const dataset = oneOf("dataset", EXPORT_DATASETS, "records");
  const preset = oneOf("preset", EXPORT_PRESETS, "generic");
  const timezone = body.timezone === undefined || body.timezone === null ? settings.timezone : String(body.timezone);
  if (!isValidTimeZone(timezone)) throw bad("timezone", `${timezone} is not an IANA time zone.`);
  const currency = body.currency === undefined || body.currency === null ? settings.reporting_currency : checkCurrency(body.currency, "currency");
  let period: Req["period"] = null;
  if (body.period !== undefined && body.period !== null) {
    if (typeof body.period !== "object" || !body.period.start || !body.period.end) throw bad("period", "period needs start and end, or null for the entire history.");
    period = { start: String(body.period.start), end: String(body.period.end) };
    if (parseBoundary(period.start, timezone, "period.start") >= parseBoundary(period.end, timezone, "period.end")) throw bad("period", "period.start must be before period.end.");
  }
  if (body.include_simulated !== undefined && typeof body.include_simulated !== "boolean") throw bad("include_simulated", "include_simulated must be a boolean.");
  if (preset !== "generic" && (dataset !== "records" || format !== "csv")) {
    throw new ApiError(422, "invalid_request_error", "invalid_export_combination", `The ${preset} preset is for the records dataset as csv; got dataset ${dataset}, format ${format}.`, "preset");
  }
  return { dataset, format, preset, period, timezone, currency, include_simulated: body.include_simulated === true };
}

const TYPES: Record<string, string> = { csv: "text/csv; charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", json: "application/json", zip: "application/zip" };

export async function buildExportFile(store: Store, exportId: string, req: Req, account: { id: string; business_name: string | null }) {
  const range = req.period ? { start: parseBoundary(req.period.start, req.timezone, "period.start"), end: parseBoundary(req.period.end, req.timezone, "period.end") } : null;
  const datasets = req.dataset === "all" ? DATASET_LIST : [req.dataset];
  const data = new Map(datasets.map((d) => [d, datasetData(store, d, req, range)]));
  const rows = [...data.values()].reduce((n, d) => n + d.table.rows.length, 0);
  const csvs = new Map(datasets.map((d) => [d, renderCsv(data.get(d)!.table)]));
  const csvSha = sha256([...csvs.values()].join("\n"));
  const dayOf = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : isoInZone(parseBoundary(v, req.timezone, "period"), req.timezone).slice(0, 10));
  const span = req.period ? `${dayOf(req.period.start)}_${dayOf(req.period.end)}` : "all-time";
  const stem = `coinvello_${req.dataset}_test_${span}`;
  const meta = { id: exportId, period: req.period, timezone: req.timezone, currency: req.currency, generated_at: utcSeconds(Date.now()), api_version: API_VERSION, sha256: csvSha };

  if (req.dataset === "all" && req.format !== "xlsx") {
    const files = datasets.map((d) => ({ name: `${d}.${req.format}`, data: Buffer.from(req.format === "csv" ? csvs.get(d)! : JSON.stringify({ object: "list", data: data.get(d)!.objects, export: meta }, null, 2)) }));
    const manifest = { object: "manifest", export: meta, files: files.map((f, i) => ({ file: f.name, rows: data.get(datasets[i])!.table.rows.length, sha256: sha256(f.data) })) };
    const text = readme(req, account, exportId, rows, csvSha, range).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n";
    return { name: `${stem}.zip`, content_type: TYPES.zip, data: zip([...files, { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) }, { name: "README.txt", data: Buffer.from(text) }]), rows };
  }
  if (req.format === "csv") return { name: `${stem}.csv`, content_type: TYPES.csv, data: Buffer.from(csvs.get(req.dataset)!), rows };
  if (req.format === "json") return { name: `${stem}.json`, content_type: TYPES.json, data: Buffer.from(JSON.stringify({ object: "list", data: data.get(req.dataset)!.objects, export: meta }, null, 2)), rows };
  return { name: `${stem}.xlsx`, content_type: TYPES.xlsx, data: await workbook(store, req, datasets, data, range, account, exportId, rows, csvSha), rows };
}

export const retentionMs = RETENTION_DAYS * 86400_000;
