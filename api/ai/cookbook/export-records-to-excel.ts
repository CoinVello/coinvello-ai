// CoinVello: export a quarter of records to Excel (TypeScript, Node 18+). Single file, no dependencies.
//
// AI instructions: copy this into the project (a cron job, an admin button or a one-off script). It creates an
// `xlsx` export of the `records` dataset for one quarter with an Idempotency-Key, polls GET /exports/{id} until
// `status` is `ready`, downloads the file from the signed `download_url`, and refuses to save it unless its SHA-256
// equals `file.sha256`. Never send the API key to `download_url`. Files are kept 7 days; rerun to get a new one.
// Amounts stay decimal strings; the workbook has the sheets "Read me", "Summary" and "Records".
//
// The two value columns: `contract_value` (CSV: contract_amount) is what the customer owed in the invoice
// currency at the rate locked when the invoice was created, i.e. the sale; `value` (value_amount) is what the
// coins were worth on the market, in your reporting currency, at the block time, i.e. the income and the cost
// basis of what now sits in your wallet. The difference is a valuation difference, not an error. Accountants
// differ on which one to book, so both are exported (`value_usd` is the common USD column) and the Summary
// sheet reports `sales`, `received_market_value` and their difference. CoinVello is not a tax adviser.
//
// Env:  COINVELLO_API_KEY=cv_test_...   COINVELLO_API_BASE=https://api.coinvello.com/v1 (or http://localhost:4242/v1)
//       TIMEZONE=Europe/Berlin (IANA, default: the account's records timezone)   CURRENCY=EUR (default: account's)
// Run:  npx tsx export-records-to-excel.ts                  # last full calendar quarter (UTC)
//       npx tsx export-records-to-excel.ts 2026-07-01 2026-10-01   # start inclusive, end exclusive
// Test: against the mock (cd api/reference-server && npm start) pay an invoice with POST /test/simulate_payment
//       first; with a cv_test_ key this script sets include_simulated, otherwise simulated rows stay hidden.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const API = process.env.COINVELLO_API_BASE ?? "https://api.coinvello.com/v1";
const KEY = process.env.COINVELLO_API_KEY ?? (() => { throw new Error("COINVELLO_API_KEY missing"); })();
const TESTING = KEY.startsWith("cv_test_");

interface Export {
  id: string; status: "queued" | "processing" | "ready" | "failed" | "expired"; rows?: number | null;
  file?: { name: string; content_type: string; bytes: number; sha256: string } | null;
  download_url?: string | null; failure_reason?: string | null;
}

async function coinvello<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.error?.code ?? ""} ${json.error?.message ?? ""}`.trim());
  return json as T;
}

/** The last full calendar quarter before `now`, as ["2026-07-01", "2026-10-01"]: start inclusive, end exclusive. */
function lastQuarter(now = new Date()): [string, string] {
  const q = Math.floor(now.getUTCMonth() / 3);
  const start = new Date(Date.UTC(q === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear(), q === 0 ? 9 : (q - 1) * 3, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [start, end] = process.argv.length >= 4 ? [process.argv[2], process.argv[3]] : lastQuarter();
  const options = {
    period: { start, end },
    ...(process.env.TIMEZONE ? { timezone: process.env.TIMEZONE } : {}),
    ...(process.env.CURRENCY ? { currency: process.env.CURRENCY } : {}),
    ...(TESTING ? { include_simulated: true } : {}),
  };

  // 1. Create the export. Same key + same body replays the same export, so a retry never starts a second one;
  //    the date keeps tomorrow's rerun (after the 7-day expiry, say) from replaying an old, expired export.
  const key = `records-xlsx-${start}-${end}-${new Date().toISOString().slice(0, 10)}`;
  let exp = await coinvello<Export>("POST", "/exports", { dataset: "records", format: "xlsx", ...options }, key);

  // 2. Small exports come back `ready`; larger ones are built in the background (or listen for `export.ready`).
  for (const deadline = Date.now() + 10 * 60_000; exp.status === "queued" || exp.status === "processing"; ) {
    if (Date.now() > deadline) throw new Error(`export ${exp.id} still ${exp.status} after 10 minutes`);
    await sleep(2000);
    exp = await coinvello<Export>("GET", `/exports/${exp.id}`);
  }
  if (exp.status !== "ready" || !exp.file || !exp.download_url) throw new Error(`export ${exp.id} is ${exp.status}: ${exp.failure_reason ?? "no file"}`);

  // 3. Download from the signed URL (no Authorization header) and verify the hash before keeping the file.
  const res = await fetch(exp.download_url);
  if (!res.ok) throw new Error(`download failed: ${res.status} (the link expires; GET /exports/${exp.id} for a fresh one)`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== exp.file.sha256 || bytes.length !== exp.file.bytes) throw new Error(`checksum mismatch for ${exp.file.name}: got ${sha256}, expected ${exp.file.sha256}`);
  await mkdir("exports", { recursive: true });
  const path = join("exports", exp.file.name);
  await writeFile(path, bytes);
  console.log(`saved ${path}: ${exp.rows ?? "?"} records, ${bytes.length} bytes, sha256 ${sha256}`);

  // 4. The same period as totals, so the workbook can be cross-checked: sales vs. market value received.
  const query = new URLSearchParams({ period_start: start, period_end: end, ...(TESTING ? { include_simulated: "true" } : {}) });
  for (const k of ["timezone", "currency"] as const) if (options[k]) query.set(k, options[k]!);
  const s = await coinvello<Record<string, string | number>>("GET", `/records/summary?${query}`);
  console.log(`${start} .. ${end} (${s.currency}): sales ${s.sales}, received at market ${s.received_market_value}, difference ${s.valuation_difference}, fees ${s.fees_prepaid}, net received ${s.net_received}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
