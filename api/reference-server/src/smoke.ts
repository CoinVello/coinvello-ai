/**
 * Smoke test: boots the app on a random port, creates a webhook pointing at the built-in sink,
 * creates an invoice, simulates a payment, verifies the delivered signature, and buys credits.
 *
 *   npm run smoke
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import ExcelJS from "exceljs";
import type { AddressInfo } from "node:net";

process.env.NO_LISTEN = "1";
process.env.QUIET = "1";
const { app, store } = await import("./index.js");

const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}/v1`;
const H = { Authorization: "Bearer cv_test_smoke", "Content-Type": "application/json" };

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(base + path, { method, headers: { ...H, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json as any;
}
const assert = (cond: unknown, msg: string) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok  ", msg); };

try {
  const wh = await call("POST", "/webhooks", { url: `${base}/webhook-sink`, events: ["*"] });
  assert(wh.secret?.startsWith("whsec_"), "webhook created with secret");

  const inv = await call("POST", "/invoices", { amount: "49.99", currency: "USD", accepted_assets: ["btc:bitcoin", "usdt:tron", "usdc:polygon"], order_id: "WC-1", success_url: "https://x.test/ok" }, { "Idempotency-Key": "smoke-1" });
  assert(inv.status === "new" && inv.payment_options.length === 3, "invoice created with 3 payment options");
  assert(inv.payment_options[0].payment_uri.startsWith("bitcoin:"), "BIP-21 uri");
  assert(inv.payment_options[2].payment_uri.startsWith("ethereum:0x") && inv.payment_options[2].payment_uri.includes("/transfer?"), "EIP-681 token uri");

  const replay = await fetch(base + "/invoices", { method: "POST", headers: { ...H, "Idempotency-Key": "smoke-1" }, body: JSON.stringify({ amount: "49.99", currency: "USD", accepted_assets: ["btc:bitcoin", "usdt:tron", "usdc:polygon"], order_id: "WC-1", success_url: "https://x.test/ok" }) });
  assert(replay.headers.get("Idempotency-Replayed") === "true" && (await replay.json()).id === inv.id, "idempotent replay returns same invoice");

  const s1 = await call("POST", "/test/simulate_payment", { invoice_id: inv.id, asset: "usdt:tron", confirmations: 0, tx_hash: "abc" });
  assert(s1.invoice.status === "confirming" && s1.payment.status === "detected", "0-conf payment -> confirming");
  const s2 = await call("POST", "/test/simulate_payment", { invoice_id: inv.id, asset: "usdt:tron", confirmations: 19, tx_hash: "abc" });
  assert(s2.invoice.status === "paid" && s2.payment.status === "confirmed", "19-conf payment -> paid");

  const events = await call("GET", "/events?related_object_id=" + inv.id);
  const types = events.data.map((e: any) => e.type);
  assert(types.includes("invoice.paid") && types.includes("invoice.confirming"), `events emitted: ${types.reverse().join(", ")}`);

  const sink = await call("GET", "/webhook-sink");
  const paid = sink.data.find((d: any) => d.body?.type === "invoice.paid");
  assert(paid, "invoice.paid delivered to sink");
  const [tPart, vPart] = (paid.signature as string).split(",");
  const t = tPart.slice(2); const v1 = vPart.slice(3);
  const expected = createHmac("sha256", wh.secret).update(`${t}.${paid.raw}`).digest("hex");
  assert(expected.length === v1.length && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(v1, "hex")), "delivered signature verifies with endpoint secret");

  // records: the confirmed payment and the credits it consumed are in the book of record (everything on the mock is simulated)
  assert((await call("GET", "/records")).data.length === 0, "records: simulated rows are hidden unless include_simulated=true");
  const recs = await call("GET", "/records?include_simulated=true&invoice_id=" + inv.id);
  const receipts = recs.data.filter((r: any) => r.type === "payment_received");
  const prepaid = recs.data.filter((r: any) => r.type === "fee_prepaid");
  assert(recs.data.length === 2 && receipts.length === 1 && prepaid.length === 1, `records for the paid invoice: 1 payment_received + 1 fee_prepaid (got ${recs.data.map((r: any) => r.type).join(", ")})`);
  const rec = receipts[0];
  assert(rec.id.startsWith("rec_") && rec.object === "record" && rec.simulated && rec.flags.includes("simulated") && rec.received.asset === "usdt:tron" && rec.related.payment_id === s2.payment.id, "payment_received record carries the asset, amount and payment id");
  assert(rec.contract_value.amount === "49.99" && rec.contract_value.currency === "USD" && rec.value.amount !== rec.contract_value.amount && rec.value_usd === rec.value.amount, `contract_value ${rec.contract_value.amount} and market value ${rec.value.amount} both show`);
  assert(prepaid[0].credits === 15 && prepaid[0].value.amount === "0.15" && prepaid[0].value.source.provider === "credits_nominal", "fee_prepaid record: 15 credits valued at $0.01 each");
  assert((await call("GET", `/records/${rec.id}`)).id === rec.id, "GET /records/{id}");
  const day = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  const sum = await call("GET", `/records/summary?period_start=${day(-1)}&period_end=${day(1)}&include_simulated=true`);
  assert(sum.object === "records_summary" && sum.sales === inv.amount && sum.payments_count === 1 && sum.invoices_paid === 1 && sum.fees_prepaid === "0.15" && sum.credits_consumed === 15, `summary: sales ${sum.sales} equals the invoice amount ${inv.amount}`);
  assert(sum.received_market_value === rec.value.amount && sum.valuation_difference === (Number(rec.value.amount) - Number(inv.amount)).toFixed(2), `summary: received ${sum.received_market_value}, valuation difference ${sum.valuation_difference}`);

  const GENERIC = "record_id, type, flags, occurred_at, occurred_at_utc, recorded_at_utc, description, invoice_id, invoice_status, order_id, checkout_session_id, customer_reference, invoice_amount, invoice_currency, received_asset, received_amount, received_amount_minor, sent_asset, sent_amount, sent_amount_minor, fee_asset, fee_amount, chain, tx_hash, tx_index, block_height, from_address, to_address, derivation_path, explorer_url, contract_currency, contract_amount, contract_rate, value_currency, value_amount, value_rate, value_rate_as_of, value_source, value_snapshot_id, value_usd, tax_amount, tax_rate, tax_label, tax_jurisdiction, credits, related_ids, reverses_record_id, livemode, simulated, metadata_json".split(", ").join(",");
  const exp = await call("POST", "/exports", { dataset: "records", format: "csv", include_simulated: true }, { "Idempotency-Key": "smoke-export-1" });
  assert(exp.id.startsWith("exp_") && exp.status === "ready" && exp.rows === 2 && exp.preset === "generic" && exp.period === null && exp.file.name === "coinvello_records_test_all-time.csv", "csv export is created ready for the entire history");
  const dl = await fetch(`${base}/exports/${exp.id}/download`, { headers: H });
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert(dl.status === 200 && dl.headers.get("content-type")?.startsWith("text/csv") && dl.headers.get("content-disposition")?.includes(exp.file.name), "download streams the file with the csv content type");
  assert(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, "csv starts with a UTF-8 BOM");
  const lines = bytes.toString("utf8").slice(1).split("\n");
  assert(lines[0] === GENERIC && lines.length === 4 && lines[3] === "", "csv header row matches design section 4.3 and has one line per record");
  assert(createHash("sha256").update(bytes).digest("hex") === exp.file.sha256 && bytes.length === exp.file.bytes, "file.sha256 and file.bytes match the download");
  const viaUrl = await fetch(exp.download_url);
  assert(viaUrl.status === 200 && Buffer.from(await viaUrl.arrayBuffer()).equals(bytes), "download_url serves the same bytes without an API key");
  assert((await fetch(exp.download_url.replace(/sig=[0-9a-f]{6}/, "sig=000000"))).status === 403, "a tampered download_url is refused");

  const under = await call("POST", "/invoices", { amount: "100", currency: "EUR", accepted_assets: ["btc:bitcoin"] });
  await call("POST", "/invoices/" + under.id + "/expire");
  const s3 = await call("POST", "/test/simulate_payment", { invoice_id: under.id, asset: "btc:bitcoin", amount: "0.0005", confirmations: 1 });
  assert(s3.invoice.status === "underpaid" && s3.invoice.refund_claim_url, "late partial payment -> underpaid with refund_claim_url");

  const cs = await call("POST", "/checkout-sessions", { amount: "10.00", currency: "USD", success_url: "https://x.test/ok", line_items: [{ name: "A", quantity: 2, unit_amount: "5.00" }] });
  assert(cs.url.includes("/c/cs_"), "checkout session url");
  await call("POST", "/test/simulate_payment", { invoice_id: cs.invoice_id, asset: "usdc:polygon", confirmations: 64 });
  const cs2 = await call("GET", "/checkout-sessions/" + cs.id + "?expand=invoice");
  assert(cs2.status === "complete" && cs2.invoice.status === "paid", "checkout session completes when invoice paid");

  // fee model: $49.99 -> round(49.99 * 0.30) = 15 credits; $10 -> 3; $100 EUR underpaid 0.0005 BTC (~$33.68) -> 10
  const invPaid = await call("GET", "/invoices/" + inv.id);
  assert(invPaid.fee?.credits === 15 && invPaid.fee.bps === 30, `paid $49.99 invoice consumed ${invPaid.fee?.credits} credits (expected 15)`);
  const feeLedger = await call("GET", "/credits/ledger?reason=invoice_fee");
  assert(feeLedger.data.some((l: any) => l.amount === 15 && l.related_object.id === inv.id), "ledger has invoice_fee debit of 15");
  assert((await call("GET", "/invoices/" + under.id)).fee?.credits === 10, "underpaid invoice charged on amount received (10 credits)");

  const bal = await call("GET", "/credits/balance");
  assert(bal.balance === bal.available + bal.reserved && bal.available >= 0 && !("overage_limit" in bal) && !("free_monthly" in bal), "credits balance: balance = available + reserved, no overage or free grant");
  const open = await call("POST", "/invoices", { amount: "100.00", currency: "USD", accepted_assets: ["usdc:base"] });
  const held = await call("GET", "/credits/balance");
  assert(held.reserved - bal.reserved === 30 && held.balance === bal.balance, "open $100 invoice reserves its estimated fee (30 credits)");
  await call("POST", `/invoices/${open.id}/cancel`);
  assert((await call("GET", "/credits/balance")).reserved === bal.reserved, "cancelled invoice releases its reservation");
  const acct0 = await call("GET", "/account");
  assert(acct0.auto_switch_to_pay_as_you_go === true, "account.auto_switch_to_pay_as_you_go defaults to true");
  assert((await call("PATCH", "/account", { auto_switch_to_pay_as_you_go: false })).auto_switch_to_pay_as_you_go === false, "auto_switch_to_pay_as_you_go is PATCHable");
  await call("PATCH", "/account", { auto_switch_to_pay_as_you_go: true });
  const held0 = store.credits.balance; store.credits.balance = 0; process.env.MOCK_CREDITS_RUN_OUT = "1";
  const r402 = await fetch(base + "/invoices", { method: "POST", headers: H, body: JSON.stringify({ amount: "50.00", currency: "USD" }) });
  const e402 = (await r402.json() as any).error;
  delete process.env.MOCK_CREDITS_RUN_OUT; store.credits.balance = held0;
  assert(r402.status === 402 && e402.code === "insufficient_credits" && e402.details.available === 0 && e402.details.required === 15 && !("overage_limit" in e402.details), "out of credits (MOCK_CREDITS_RUN_OUT=1): 402 with details { available, required, bundles_url }");

  const before = (await call("GET", "/credits/balance")).available;
  const bundles = await call("GET", "/credits/bundles");
  const ids = bundles.data.map((b: any) => b.id);
  assert(!ids.includes("bnd_free_500") && bundles.data.every((b: any) => !b.monthly), "no free monthly bundle");
  assert(["bnd_starter_2500", "bnd_growth_15000", "bnd_scale_75000", "bnd_volume_400000", "bnd_enterprise"].every((x) => ids.includes(x)), "canonical bundle ids seeded");
  const growth = bundles.data.find((b: any) => b.id === "bnd_growth_15000");
  assert(growth.price_per_credit === "0.0080" && growth.effective_rate_bps === 24 && growth.crypto_prices.some((c: any) => c.discount_applied), "Growth bundle $0.008/credit, 24 bps, stablecoin discount in crypto_prices");
  const cp = await call("POST", "/credits/purchases", { bundle_id: "bnd_growth_15000", pay_asset: "usdt", pay_chain: "tron" });
  assert(cp.payment.payment_options.length === 1 && cp.checkout_url.includes("/credits/") && cp.price.amount === "116.40" && cp.discount?.bps === 300, "credit purchase: single option, 3% stablecoin discount ($120 -> $116.40)");
  await call("POST", "/test/simulate_payment", { invoice_id: cp.id, confirmations: 19 });
  const after = (await call("GET", "/credits/balance")).available;
  assert(after - before === 15000, `credits balance +15000 after purchase (${before} -> ${after})`);
  const ledger = await call("GET", "/credits/ledger");
  assert(ledger.data[0].reason === "purchase" && ledger.data[0].type === "credit", "ledger shows purchase credit");
  const bad402 = await fetch(base + "/credits/purchases", { method: "POST", headers: H, body: JSON.stringify({ bundle_id: "bnd_enterprise" }) });
  assert(bad402.status === 409, "enterprise bundle requires contact sales (409)");

  // public view + SSE (no auth)
  const cs3 = await call("POST", "/checkout-sessions", { amount: "20.00", currency: "USD", accepted_assets: ["usdc:base"], success_url: "https://x.test/ok", order_id: "SSE-1" });
  const pubRes = await fetch(`${base}/checkout-sessions/${cs3.id}/public`);
  const pub = await pubRes.json();
  assert(pubRes.status === 200 && pubRes.headers.get("access-control-allow-origin") === "*", "public endpoint needs no auth and is CORS-open");
  const po = pub.payment_options[0];
  assert(pub.object === "checkout_session.public" && pub.status === "pending" && pub.purpose === "payment" && po.uri === po.payment_uri && po.chain_id === "84532" && po.token_contract && po.rate_locked_until && !("metadata" in pub), "public projection has SDK aliases and no secrets");
  const received: string[] = [];
  const ctrl = new AbortController();
  const sse = await fetch(`${base}/checkout-sessions/${cs3.id}/events`, { signal: ctrl.signal, headers: { Accept: "text/event-stream" } });
  assert(sse.headers.get("content-type")?.startsWith("text/event-stream"), "SSE endpoint streams text/event-stream");
  const reader = sse.body!.getReader(); const dec = new TextDecoder(); let buf = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(frame)?.[1]; const data = /data: (.*)/.exec(frame)?.[1];
        if (ev === "status" && data) received.push(JSON.parse(data).status);
      }
    }
  })().catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  await call("POST", "/test/simulate_payment", { invoice_id: cs3.invoice_id, asset: "usdc:base", confirmations: 0, tx_hash: "sse" });
  await call("POST", "/test/simulate_payment", { invoice_id: cs3.invoice_id, asset: "usdc:base", confirmations: 12, tx_hash: "sse" });
  await new Promise((r) => setTimeout(r, 300));
  ctrl.abort(); await pump;
  assert(received[0] === "pending" && received.includes("confirming") && received[received.length - 1] === "paid", `SSE status events: ${received.join(" -> ")}`);
  const pubCp = await (await fetch(`${base}/checkout-sessions/${cp.id}/public`)).json();
  assert(pubCp.purpose === "credits" && pubCp.merchant.name === "CoinVello" && pubCp.status === "paid", "credit purchase served via public endpoint with purpose=credits");

  // records, part two: credit purchases, filters, pagination, re-valuation, tax, account settings, presets and every format
  const purchase = (await call("GET", "/records?include_simulated=true&type=credit_purchase")).data;
  assert(purchase.length === 1 && purchase[0].credits === 15000 && purchase[0].sent.asset === "usdt:tron" && purchase[0].contract_value.amount === "116.40" && purchase[0].related.credit_purchase_id === cp.id, "credit_purchase record: crypto sent, 15000 credits, price charged");
  const everything = (await call("GET", "/records?include_simulated=true&limit=100")).data;
  assert(everything.every((r: any, i: number) => i === 0 || everything[i - 1].occurred_at >= r.occurred_at), "records are listed newest first");
  const p1 = await call("GET", "/records?include_simulated=true&limit=2");
  const p2 = await call("GET", "/records?include_simulated=true&limit=2&cursor=" + p1.next_cursor);
  assert(p1.has_more && p1.data.length === 2 && p2.data.length === 2 && !p2.data.some((r: any) => p1.data.some((q: any) => q.id === r.id)), "records: cursor pagination walks the list without repeats");
  const count = async (query: string) => (await call("GET", `/records?include_simulated=true&limit=100&${query}`)).data.length;
  assert((await count("asset=btc:bitcoin")) === 1 && (await count("chain=tron")) === 2 && (await count("tx_hash=abc")) === 1 && (await count("order_id=WC-1")) === 2, "records: asset, chain, tx_hash and order_id filters");
  assert((await count("occurred_gte=" + encodeURIComponent(new Date(Date.now() + 3600e3).toISOString()))) === 0 && (await count("occurred_lte=" + encodeURIComponent(new Date(Date.now() + 3600e3).toISOString()))) === everything.length, "records: occurred_gte and occurred_lte bound the list");
  const inEur = (await call("GET", `/records/${rec.id}?currency=EUR`));
  assert(inEur.value.currency === "EUR" && inEur.value_usd === rec.value_usd && inEur.value.amount === (Number(rec.value_usd) * 0.9195).toFixed(2), `currency=EUR re-values from value_usd (${rec.value.amount} USD -> ${inEur.value.amount} EUR)`);
  const bad400 = async (path: string) => (await fetch(base + path, { headers: H })).status;
  assert((await bad400("/records?type=bogus")) === 400 && (await bad400("/records?currency=XXX")) === 400 && (await bad400("/records/summary?period_start=2026-01-01")) === 400 && (await bad400("/records/summary?period_start=2026-01-01&period_end=2026-01-01")) === 400 && (await bad400("/records/rec_nope")) === 404, "records: invalid filters are 400, a missing record is 404");

  const taxed = await call("POST", "/invoices", { amount: "49.99", currency: "EUR", accepted_assets: ["usdc:base"], order_id: "TAX-1", customer: { reference: "cus_88", email: "payer@example.com" }, tax: { amount: "7.98", rate: "0.19", label: "VAT 19%", jurisdiction: "DE" } });
  assert(taxed.tax.amount === "7.98" && taxed.tax.rate === "0.19" && taxed.tax.label === "VAT 19%" && taxed.tax.jurisdiction === "DE" && inv.tax === null, "tax is accepted and echoed on the invoice (null when absent)");
  assert((await fetch(base + "/invoices", { method: "POST", headers: H, body: JSON.stringify({ amount: "10", currency: "USD", tax: { amount: "11" } }) })).status === 400, "a tax portion larger than the invoice is refused");
  await call("POST", "/test/simulate_payment", { invoice_id: taxed.id, asset: "usdc:base", confirmations: 12 });
  const taxedRec = (await call("GET", "/records?include_simulated=true&type=payment_received&invoice_id=" + taxed.id)).data[0];
  assert(taxedRec.tax.amount === "7.98" && taxedRec.tax.jurisdiction === "DE" && taxedRec.contract_value.currency === "EUR" && taxedRec.invoice.currency === "EUR" && taxedRec.invoice.customer_reference === "cus_88" && !JSON.stringify(taxedRec).includes("payer@example.com"), "record copies the invoice tax and customer reference, never the payer's email");
  const byType = await call("GET", `/records/summary?period_start=${day(-1)}&period_end=${day(1)}&include_simulated=true&currency=EUR&group_by=type`);
  assert(byType.currency === "EUR" && byType.tax_collected === "7.98" && byType.group_by === "type" && byType.groups.map((g: any) => g.key).sort().join() === "credit_purchase,fee_prepaid,payment_received", "summary in EUR: tax collected 7.98, grouped by type");
  assert(Number(byType.credit_purchases) > 0 && byType.groups.find((g: any) => g.key === "fee_prepaid").credits_consumed === byType.credits_consumed, "summary: credit purchases and consumed credits");
  const byMonth = await call("GET", `/records/summary?period_start=${day(-1)}&period_end=${day(1)}&include_simulated=true&group_by=month`);
  const byAsset = await call("GET", `/records/summary?period_start=${day(-1)}&period_end=${day(1)}&include_simulated=true&group_by=asset`);
  assert(byMonth.groups.length >= 1 && byMonth.groups.every((g: any) => /^\d{4}-\d{2}$/.test(g.key)) && byAsset.groups.some((g: any) => g.key === "usdt:tron"), "summary: groups by month and asset");
  assert((await call("GET", `/records/summary?period_start=${day(-1)}&period_end=${day(1)}`)).payments_count === 0, "summary: simulated rows count only with include_simulated=true");

  const acct = await call("PATCH", "/account", { records: { reporting_currency: "EUR", timezone: "Europe/Berlin", fiscal_year_start: "04-06" } });
  assert(acct.records.reporting_currency === "EUR" && acct.records.timezone === "Europe/Berlin" && acct.records.fiscal_year_start === "04-06" && (await call("GET", "/account")).records.fiscal_year_start === "04-06", "PATCH /account stores the records settings");
  assert((await fetch(base + "/account", { method: "PATCH", headers: H, body: JSON.stringify({ records: { fiscal_year_start: "13-45" } }) })).status === 400, "an invalid fiscal_year_start is refused");
  assert((await call("GET", "/records?include_simulated=true&limit=1")).data[0].value.currency === "EUR", "records default to the account's reporting currency");
  const berlin = await call("POST", "/exports", { format: "csv", include_simulated: true, dataset: "payments" });
  const berlinRecs = await call("POST", "/exports", { format: "csv", include_simulated: true });
  assert(berlinRecs.currency === "EUR" && berlinRecs.timezone === "Europe/Berlin" && berlin.dataset === "payments", "exports default to the account's currency and timezone");
  const berlinCsv = Buffer.from(await (await fetch(`${base}/exports/${berlinRecs.id}/download`, { headers: H })).arrayBuffer()).toString("utf8").slice(1).split("\n");
  const cols = berlinCsv[0].split(",");
  const firstRow = berlinCsv[1].split(",");
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(firstRow[cols.indexOf("occurred_at")]) && firstRow[cols.indexOf("occurred_at_utc")].endsWith("Z") && firstRow[cols.indexOf("value_currency")] === "EUR", "csv timestamps carry the export timezone's offset plus a UTC column");
  await call("PATCH", "/account", { records: { reporting_currency: "USD", timezone: "UTC", fiscal_year_start: "01-01" } });

  const download = async (e: any) => Buffer.from(await (await fetch(`${base}/exports/${e.id}/download`, { headers: H })).arrayBuffer());
  const period = { start: day(-1), end: day(1) };
  const xlsx = await call("POST", "/exports", { dataset: "records", format: "xlsx", period, timezone: "America/New_York", currency: "USD", include_simulated: true });
  assert(xlsx.file.name === `coinvello_records_test_${day(-1)}_${day(1)}.xlsx` && xlsx.file.content_type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" && xlsx.rows > 0, "xlsx export: file name and content type");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await download(xlsx) as any);
  const sheet = book.getWorksheet("Records")!;
  const head = (sheet.getRow(1).values as string[]).slice(1);
  const row2 = sheet.getRow(2);
  const cell = (name: string) => row2.getCell(head.indexOf(name) + 1).value;
  assert(book.worksheets.map((w) => w.name).join() === "Read me,Summary,Records" && head[3] === "occurred_at" && head[4] === "occurred_at_iso" && head.length === GENERIC.split(",").length + 1, "xlsx: Read me, Summary and Records sheets; ISO text column next to the date");
  assert(cell("occurred_at") instanceof Date && typeof cell("value_usd") === "number" && typeof cell("value_amount") === "number" && typeof cell("received_amount") === "string" && typeof cell("tx_hash") === "string" && typeof cell("record_id") === "string", "xlsx: fiat values and dates are typed cells; crypto amounts, hashes and ids are text");
  assert(sheet.views[0].state === "frozen" && !!sheet.autoFilter && String(book.getWorksheet("Summary")!.getCell("A1").value).startsWith("Totals (USD, America/New_York)"), "xlsx: header frozen, autofilter on, summary totals present");

  const json = await call("POST", "/exports", { dataset: "records", format: "json", include_simulated: true });
  const jsonBody = JSON.parse((await download(json)).toString("utf8"));
  assert(jsonBody.object === "list" && jsonBody.data.length === json.rows && jsonBody.data[0].object === "record" && jsonBody.export.id === json.id && jsonBody.export.sha256.length === 64 && jsonBody.data[0].occurred_at <= jsonBody.data[1].occurred_at, "json export: the API objects, oldest first, with an export block");

  const HEADERS: Record<string, string> = {
    journal: "date,journal_no,account,debit,credit,currency,memo,record_id,tx_hash",
    quickbooks: "Date,Description,Amount",
    xero: "Date,Amount,Payee,Description,Reference",
    koinly: "Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash",
    cointracker: "Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag",
    coinledger: "Date (UTC),Platform (Optional),Asset Sent,Amount Sent,Asset Received,Amount Received,Fee Currency (Optional),Fee Amount (Optional),Type,Description (Optional),TxHash (Optional)",
  };
  const presetLines: Record<string, string[]> = {};
  for (const [preset, header] of Object.entries(HEADERS)) {
    const e = await call("POST", "/exports", { dataset: "records", format: "csv", preset, include_simulated: true });
    presetLines[preset] = (await download(e)).toString("utf8").slice(1).split("\n").filter(Boolean);
    assert(e.preset === preset && presetLines[preset][0] === header && presetLines[preset].length > 1, `preset ${preset}: header row and ${presetLines[preset].length - 1} rows`);
  }
  const debit = presetLines.journal.slice(1).map((l) => l.split(",")).reduce((n, c) => n + Math.round(Number(c[3] || 0) * 100), 0);
  const credit = presetLines.journal.slice(1).map((l) => l.split(",")).reduce((n, c) => n + Math.round(Number(c[4] || 0) * 100), 0);
  assert(debit === credit && debit > 0, `preset journal: debits equal credits (${debit / 100})`);
  const payments = everything.filter((r: any) => r.type === "payment_received").length + 1; // + the taxed invoice paid since
  assert(presetLines.koinly.filter((l) => l.includes(",income,")).length === payments && presetLines.cointracker.filter((l) => l.endsWith(",payment")).length === payments && presetLines.coinledger.filter((l) => l.includes(",Income,")).length === payments, `crypto-tax presets label the ${payments} receipts as income`);
  assert(presetLines.quickbooks.slice(1).every((l) => /^\d{2}\/\d{2}\/\d{4},/.test(l)) && presetLines.quickbooks.slice(1).some((l) => /,-\d+\.\d{2}$/.test(l)) && presetLines.xero.slice(1).every((l) => /^\d{2}\/\d{2}\/\d{4},/.test(l)), "bank-feed presets: dates and signed amounts");

  const post = (body: unknown) => fetch(base + "/exports", { method: "POST", headers: H, body: JSON.stringify(body) });
  assert((await post({ dataset: "records", format: "xlsx", preset: "koinly" })).status === 422 && (await post({ dataset: "invoices", format: "csv", preset: "xero" })).status === 422 && (await post({ dataset: "all", format: "csv", preset: "journal" })).status === 422, "a preset only fits records + csv (422)");
  assert((await post({ dataset: "records" })).status === 400 && (await post({ format: "pdf" })).status === 400 && (await post({ format: "csv", preset: "foo" })).status === 400 && (await post({ format: "csv", period: { start: "2026-02-01", end: "2026-01-01" } })).status === 400 && (await post({ format: "csv", timezone: "Mars/Olympus" })).status === 400, "export validation: missing/unknown format, preset, reversed period, bad timezone are 400");

  const invCsv = (await download(await call("POST", "/exports", { dataset: "invoices", format: "csv" }))).toString("utf8");
  assert(invCsv.includes("cus_88") && !invCsv.includes("payer@example.com") && invCsv.split("\n")[0].includes("customer_reference"), "invoices export keeps the merchant's customer reference and drops the payer's email");
  const pack = await call("POST", "/exports", { dataset: "all", format: "xlsx", include_simulated: true });
  const packBook = new ExcelJS.Workbook();
  await packBook.xlsx.load(await download(pack) as any);
  assert(packBook.worksheets.map((w) => w.name).join() === "Read me,Summary,Records,Invoices,Payments,Refunds,Sweeps,Credit ledger,Credit purchases,Conversions,Off-ramp payouts", "year-end package (xlsx): a sheet per dataset");
  const zipExport = await call("POST", "/exports", { dataset: "all", format: "csv", include_simulated: true });
  const zipBytes = await download(zipExport);
  assert(zipExport.file.name.endsWith(".zip") && zipExport.file.content_type === "application/zip" && zipBytes.readUInt32LE(0) === 0x04034b50 && ["records.csv", "invoices.csv", "manifest.json", "README.txt"].every((n) => zipBytes.includes(n)), "year-end package (csv): a zip with a file per dataset, manifest.json and README.txt");

  const sink2 = await call("GET", "/webhook-sink");
  const ready = sink2.data.find((d: any) => d.body?.type === "export.ready" && d.body.data.object.id === exp.id);
  assert(ready && ready.body.data.object.status === "ready" && ready.body.data.object.file.sha256 === exp.file.sha256, "export.ready delivered to the sink with the export object");
  const [rt, rv] = (ready.signature as string).split(",");
  assert(createHmac("sha256", wh.secret).update(`${rt.slice(2)}.${ready.raw}`).digest("hex") === rv.slice(3), "export.ready is signed like every other event");

  const replayed = await fetch(base + "/exports", { method: "POST", headers: { ...H, "Idempotency-Key": "smoke-export-1" }, body: JSON.stringify({ dataset: "records", format: "csv", include_simulated: true }) });
  assert(replayed.headers.get("Idempotency-Replayed") === "true" && (await replayed.json()).id === exp.id, "POST /exports honours Idempotency-Key");
  assert((await call("GET", "/exports?dataset=records&status=ready&limit=100")).data.some((e: any) => e.id === exp.id) && (await call("GET", "/exports/" + exp.id)).file.sha256 === exp.file.sha256 && (await call("GET", "/exports?status=queued")).data.length === 0, "GET /exports lists and filters, GET /exports/{id} retrieves");
  const stale = await call("POST", "/exports", { format: "csv" });
  store.exports.get(stale.id)!.download_expires_at = new Date(Date.now() - 1000).toISOString();
  const gone = await fetch(`${base}/exports/${stale.id}/download`, { headers: H });
  assert(gone.status === 409 && (await gone.json()).error.code === "export_expired" && (await call("GET", "/exports/" + stale.id)).status === "expired", "an export past its 7 days is expired and cannot be downloaded (409 export_expired)");
  const del = await call("DELETE", "/exports/" + exp.id);
  assert(del.deleted === true && del.id === exp.id && (await fetch(`${base}/exports/${exp.id}`, { headers: H })).status === 404 && (await fetch(`${base}/exports/${exp.id}/download`, { headers: H })).status === 404, "DELETE /exports/{id} removes the export and its file");

  const bad = await fetch(base + "/invoices/inv_nope", { headers: H });
  assert(bad.status === 404 && (await bad.json()).error.code === "resource_missing", "404 error envelope");
  const live = await fetch(base + "/invoices", { headers: { Authorization: "Bearer cv_live_x" } });
  assert(live.status === 403, "live keys rejected");

  console.log("\nAll smoke checks passed.");
} finally {
  server.close();
}
