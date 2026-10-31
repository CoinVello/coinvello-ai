// Smoke test: spawns the built server over stdio and exercises every tool against the reference
// mock server (api/reference-server, `npm start`, http://localhost:4242/v1).
//
//   COINVELLO_API_BASE=http://localhost:4242/v1 node test/smoke.mjs
//
// Exits non-zero on the first unexpected failure. Wallet CRUD is not implemented by the mock (a 404
// tool error is accepted there); against the real backend (backend/) the wallet tools must succeed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash, createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.COINVELLO_API_BASE ?? "http://localhost:4242/v1";
const key = process.env.COINVELLO_API_KEY ?? "cv_test_mcp_smoke";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(here, "..", "dist", "index.js")],
  env: { ...process.env, COINVELLO_API_BASE: base, COINVELLO_API_KEY: key },
  stderr: "pipe",
});
const client = new Client({ name: "coinvello-mcp-smoke", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
const results = [];
function record(name, ok, note = "") {
  results.push({ name, ok, note });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  - " + note : ""}`);
}

async function call(name, args, { expectError = false } = {}) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  const ok = expectError ? r.isError === true : !r.isError;
  record(name, ok, r.isError ? text.slice(0, 160).replace(/\s+/g, " ") : "");
  return data;
}

// --- discovery -------------------------------------------------------------------------------
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
const expectedTools = [
  "create_checkout_session", "get_invoice", "list_invoices", "list_payments", "create_wallet", "list_wallets",
  "create_webhook", "verify_webhook_signature", "get_credits_balance", "list_credit_bundles", "create_credit_purchase",
  "get_rates", "list_assets", "simulate_test_payment", "list_records", "get_records_summary", "create_export", "get_export",
].sort();
record("tools/list", JSON.stringify(tools) === JSON.stringify(expectedTools), tools.join(","));

const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
record("resources/list", resources.includes("coinvello://docs/llms-full.txt") && resources.includes("coinvello://openapi.yaml"), resources.join(","));
const llms = await client.readResource({ uri: "coinvello://docs/llms-full.txt" });
record("resources/read llms-full", (llms.contents[0]?.text ?? "").includes("CoinVello-Signature"));
const spec = await client.readResource({ uri: "coinvello://openapi.yaml" });
record("resources/read openapi", (spec.contents[0]?.text ?? "").includes("/checkout-sessions"));

const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
record("prompts/list", prompts.includes("integrate-coinvello-into-nextjs") && prompts.includes("integrate-coinvello-into-framework"), `${prompts.length} prompts`);
const prompt = await client.getPrompt({ name: "integrate-coinvello-into-express", arguments: { currency: "EUR" } });
record("prompts/get express", prompt.messages[0]?.content?.text?.includes("EUR"));

// --- read-only tools -------------------------------------------------------------------------
const assets = await call("list_assets", {});
record("list_assets has btc:bitcoin", assets?.data?.some((a) => a.id === "btc:bitcoin"));
await call("list_assets", { chain: "tron" });
const rates = await call("get_rates", { base: "USD", assets: ["btc:bitcoin", "usdt:tron"] });
record("get_rates shape", rates?.object === "rates" && Array.isArray(rates?.rates));
const balance = await call("get_credits_balance", {});
record("get_credits_balance shape", typeof balance?.available === "number" && typeof balance?.balance === "number" && typeof balance?.reserved === "number" && !("overage_limit" in balance) && !("free_monthly" in balance));
const bundles = await call("list_credit_bundles", {});
// First purchasable bundle: Enterprise is contact-sales and cannot be bought.
const purchasable = bundles?.data?.find((b) => !b.monthly && !b.contact_sales && b.price?.amount !== "0.00");
const bundleId = purchasable?.id ?? bundles?.data?.[0]?.id;
record("list_credit_bundles has purchasable bundle", Boolean(purchasable), bundleId ?? "");

// --- webhook to the mock's built-in sink ------------------------------------------------------
const webhook = await call("create_webhook", { url: `${base}/webhook-sink`, events: ["*"], description: "smoke" });
record("create_webhook returns whsec_", typeof webhook?.secret === "string" && webhook.secret.startsWith("whsec_"));

// --- checkout session -> simulate -> invoice -> payments --------------------------------------
const session = await call("create_checkout_session", {
  amount: "49.99", currency: "USD", accepted_assets: ["btc:bitcoin", "usdt:tron"], order_id: "SMOKE-1",
  success_url: "https://example.com/thanks", cancel_url: "https://example.com/cart",
  line_items: [{ name: "Thing", quantity: 1, unit_amount: "49.99" }], metadata: { order_id: "1" }, idempotency_key: `smoke-${Date.now()}`,
});
record("create_checkout_session shape", session?.object === "checkout_session" && typeof session?.url === "string" && session.invoice_id?.startsWith("inv_"), session?.url ?? "");

const invoiceBefore = await call("get_invoice", { id: session.invoice_id });
record("get_invoice status new", invoiceBefore?.status === "new");
await call("get_invoice", { id: session.id });

const sim = await call("simulate_test_payment", { invoice_id: session.invoice_id, asset: "usdt:tron", confirmations: 19, tx_hash: "smoke-tx" });
record("simulate_test_payment -> paid", sim?.invoice?.status === "paid" || sim?.status === "paid", JSON.stringify(sim?.invoice?.status ?? sim?.status));

const invoiceAfter = await call("get_invoice", { id: session.invoice_id });
record("get_invoice status paid", invoiceAfter?.status === "paid");

const invoices = await call("list_invoices", { status: "paid", order_id: "SMOKE-1", limit: 5 });
record("list_invoices finds paid", invoices?.data?.some((i) => i.id === session.invoice_id));
const payments = await call("list_payments", { invoice_id: session.invoice_id });
record("list_payments has payment", payments?.data?.length >= 1 && payments.data[0].status === "confirmed");

// --- verify a real delivery captured by the sink ------------------------------------------------
const sinkRes = await fetch(`${base}/webhook-sink`, { headers: { Authorization: `Bearer ${key}` } });
const sink = await sinkRes.json();
// The backend sink tags deliveries with webhook_id; the mock does not (one endpoint per run there).
const delivery = sink.data?.find((d) => d.body?.type === "invoice.paid" && (!d.webhook_id || d.webhook_id === webhook.id)) ?? sink.data?.[0];
if (delivery) {
  const rawBody = delivery.raw ?? delivery.raw_body ?? JSON.stringify(delivery.body);
  const verified = await call("verify_webhook_signature", { raw_body: rawBody, signature_header: delivery.signature, secret: webhook.secret });
  record("verify_webhook_signature real delivery valid", verified?.valid === true, verified?.reason ?? "");
} else {
  record("verify_webhook_signature real delivery", false, "sink empty");
}

// --- synthetic vectors -------------------------------------------------------------------------
const secret = "whsec_test";
const t = Math.floor(Date.now() / 1000);
const body = '{"id":"evt_1","type":"ping"}';
const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
const good = await call("verify_webhook_signature", { raw_body: body, signature_header: `t=${t},v1=${v1}`, secret });
record("verify ok", good?.valid === true);
const tampered = await call("verify_webhook_signature", { raw_body: body + " ", signature_header: `t=${t},v1=${v1}`, secret });
record("verify rejects tampered body", tampered?.valid === false && tampered?.reason === "signature mismatch");
const old = await call("verify_webhook_signature", { raw_body: body, signature_header: `t=${t - 1000},v1=${v1}`, secret });
record("verify rejects stale timestamp", old?.valid === false && /tolerance/.test(old?.reason ?? ""));
const rotated = await call("verify_webhook_signature", { raw_body: body, signature_header: `t=${t},v1=deadbeef,v1=${v1}`, secret });
record("verify accepts any v1 (rotation)", rotated?.valid === true);

// --- credits purchase ---------------------------------------------------------------------------
const purchase = await call("create_credit_purchase", { bundle_id: bundleId, pay_asset: "usdt", pay_chain: "tron" });
record("create_credit_purchase shape", purchase?.object === "credit_purchase" && typeof purchase?.checkout_url === "string");
const paidPurchase = await call("simulate_test_payment", { invoice_id: purchase.id, asset: "usdt:tron", confirmations: 19 });
record("simulate credit purchase", Boolean(paidPurchase));
const balanceAfter = await call("get_credits_balance", {});
record("credits increased", balanceAfter?.available > balance?.available, `${balance?.available} -> ${balanceAfter?.available}`);

// --- records and exports: the paid invoice above left a payment_received and a fee_prepaid record -------------
// Everything on the mock is simulated, and the spec hides simulated rows unless include_simulated is true.
const hidden = await call("list_records", { invoice_id: session.invoice_id });
record("list_records hides simulated rows by default", hidden?.object === "list" && hidden.data.length === 0);
const recs = await call("list_records", { invoice_id: session.invoice_id, include_simulated: true });
const types = (recs?.data ?? []).map((r) => r.type).sort().join();
record("list_records: payment_received + fee_prepaid for the paid invoice", types === "fee_prepaid,payment_received", types);
const rec = recs?.data?.find((r) => r.type === "payment_received");
record("record has contract_value, value, value_usd and the invoice snapshot", rec?.contract_value?.amount === "49.99" && typeof rec?.value?.amount === "string" && typeof rec?.value_usd === "string" && rec?.invoice?.order_id === "SMOKE-1" && rec?.id?.startsWith("rec_"), rec ? `contract ${rec.contract_value?.amount} / value ${rec.value?.amount}` : "");
const fees = await call("list_records", { type: "fee_prepaid", include_simulated: true, limit: 1 });
record("list_records type filter and paging", fees?.data?.length === 1 && fees.data[0].type === "fee_prepaid" && typeof fees.has_more === "boolean");
const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const summary = await call("get_records_summary", { period_start: day(-1), period_end: day(1), include_simulated: true, group_by: "type" });
record("get_records_summary: decimal-string totals and groups", typeof summary?.sales === "string" && Number(summary.sales) >= 49.99 && Number(summary.received_market_value) > 0 && Array.isArray(summary?.groups) && summary.groups.some((g) => g.key === "payment_received"), summary ? `sales ${summary.sales}, net ${summary.net_received}` : "");

const exp = await call("create_export", { dataset: "records", format: "csv", include_simulated: true, idempotency_key: `smoke-export-${Date.now()}` });
record("create_export returns a ready export with download_url and file.sha256", exp?.id?.startsWith("exp_") && exp.status === "ready" && typeof exp.download_url === "string" && exp.file?.sha256?.length === 64, exp ? `${exp.id} ${exp.file?.name}` : "");
const got = await call("get_export", { id: exp.id });
record("get_export returns the same export", got?.id === exp.id && got.status === "ready" && got.file?.sha256 === exp.file?.sha256);
const fileRes = await fetch(exp.download_url, { headers: exp.download_url.startsWith(base) ? { Authorization: `Bearer ${key}` } : {} });
const fileBytes = Buffer.from(await fileRes.arrayBuffer());
record("download_url serves the file; sha256 and header row match", fileRes.ok && createHash("sha256").update(fileBytes).digest("hex") === exp.file.sha256 && fileBytes.toString("utf8").replace(/^\uFEFF/, "").startsWith("record_id,type,flags,occurred_at,"));
await call("create_export", { dataset: "invoices", format: "xlsx", preset: "koinly" }, { expectError: true });
await call("get_export", { id: "exp_doesnotexist" }, { expectError: true });

// --- wallets (the reference mock returns 404 and the tool must surface it as a clean error; the real
// backend implements wallets and must return a wallet object) ------------------------------------
async function walletCall(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.find((c) => c.type === "text")?.text ?? "";
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  const mock404 = r.isError === true && /"http_status":\s*404/.test(text);
  const real = !r.isError && (data?.object === "wallet" || data?.object === "list");
  record(name, mock404 || real, mock404 ? "mock: 404 surfaced as tool error" : real ? "backend: wallet implemented" : text.slice(0, 160).replace(/\s+/g, " "));
  return data;
}
await walletCall("list_wallets", {});
await walletCall("create_wallet", { type: "address", chain: "polygon", label: "smoke", address: "0x8ba1f109551bD432803012645Ac136ddd64DBA72", assets: ["usdc:polygon"] });
const xprv = await client.callTool({ name: "create_wallet", arguments: { type: "xpub", chain: "bitcoin", label: "oops", xpub: "xprv9s21ZrQH143K..." } });
record("create_wallet refuses xprv locally", xprv.isError === true && /PRIVATE/.test(xprv.content[0].text));

await client.close();
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
