// CoinVello + Express (Node 18+, ESM). Single file: start-payment route + verified webhook.
//
// AI instructions: copy this file into the project, `npm i express`, set the env vars below, mount the
// two routes in the existing app (keep express.raw() on the webhook route BEFORE any express.json()),
// and replace the three TODO store functions with the project's database layer.
//
// Env:  COINVELLO_API_KEY=cv_test_...  COINVELLO_WEBHOOK_SECRET=whsec_...
//       COINVELLO_API_BASE=https://api.coinvello.com/v1 (or http://localhost:4242/v1 for the mock)  APP_URL=http://localhost:3000
// Run:  node express.mjs   ->  POST http://localhost:3000/pay/ORDER-1  (redirects to pay.coinvello.com)
// Test: see ../README.md (register http://localhost:3000/webhooks/coinvello as webhook, simulate a payment).
import express from "express";
import crypto from "node:crypto";

const API = process.env.COINVELLO_API_BASE ?? "https://api.coinvello.com/v1";
const KEY = process.env.COINVELLO_API_KEY ?? (() => { throw new Error("COINVELLO_API_KEY missing"); })();
const SECRET = process.env.COINVELLO_WEBHOOK_SECRET ?? "";
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

// --- TODO: replace with your database -----------------------------------------------------------
const orders = new Map();                 // orderId -> { total, status, checkout_session_id, invoice_id }
const processedEvents = new Set();        // event ids, keep >= 3 days in production
const loadOrder = async (id) => orders.get(id) ?? orders.set(id, { id, total: "49.99", status: "unpaid" }).get(id);
const saveOrder = async (o) => orders.set(o.id, o);
// -----------------------------------------------------------------------------------------------

async function coinvello(method, path, body, idempotencyKey) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json.error?.message ?? `CoinVello ${res.status}`);
    e.code = json.error?.code; e.status = res.status; e.requestId = json.error?.request_id;
    throw e;
  }
  return json;
}

export function verifyCoinVelloSignature(rawBody, header, secret, toleranceSec = 300) {
  if (!header) throw new Error("missing CoinVello-Signature");
  let t = 0; const sigs = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("="); const v = rest.join("=");
    if (k === "t") t = Number(v);
    if (k === "v1") sigs.push(v);
  }
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new Error("timestamp outside tolerance");
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(body).digest();
  const ok = sigs.some((s) => { const b = Buffer.from(s, "hex"); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  if (!ok) throw new Error("signature mismatch");
  return JSON.parse(body.toString("utf8"));
}

const app = express();

// 1. Start a payment: create a hosted checkout session and redirect the customer to it.
app.post("/pay/:orderId", express.json(), async (req, res, next) => {
  try {
    const order = await loadOrder(req.params.orderId);
    const session = await coinvello("POST", "/checkout-sessions", {
      amount: order.total,                                   // decimal string, never a float
      currency: "USD",
      accepted_assets: ["btc:bitcoin", "eth:ethereum", "usdc:polygon", "usdt:tron"],
      order_id: order.id,
      success_url: `${APP_URL}/orders/${order.id}/thanks`,
      cancel_url: `${APP_URL}/orders/${order.id}`,
      metadata: { order_id: String(order.id) },
    }, `order-${order.id}-checkout`);                        // stable key: retries return the same session
    await saveOrder({ ...order, checkout_session_id: session.id, invoice_id: session.invoice_id });
    res.redirect(303, session.url);
  } catch (e) {
    if (e.code === "insufficient_credits") return res.status(503).send("Crypto payments temporarily unavailable");
    next(e);
  }
});

// 2. Webhook: raw body, verify, dedupe, fulfil on invoice.paid. Must answer 2xx within 10 s.
app.post("/webhooks/coinvello", express.raw({ type: "application/json" }), async (req, res) => {
  let event;
  try {
    event = verifyCoinVelloSignature(req.body, req.get("CoinVello-Signature"), SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
  if (processedEvents.has(event.id)) return res.sendStatus(200);
  const inv = event.data.object;
  const order = inv.order_id ? await loadOrder(inv.order_id) : null;
  switch (event.type) {
    case "invoice.paid":
      if (order) await saveOrder({ ...order, status: "paid", paid_at: inv.paid_at });   // fulfil here (or enqueue)
      break;
    case "invoice.underpaid":
    case "invoice.overpaid":
    case "invoice.expired":
      if (order) await saveOrder({ ...order, status: event.type.split(".")[1] });
      break;
    default:
      break;                                                   // invoice.confirming, payment.detected, ...
  }
  processedEvents.add(event.id);
  res.sendStatus(200);
});

// 3. Success page / reconciliation: never mark paid here, just show the live status.
app.get("/orders/:orderId/thanks", async (req, res) => {
  const order = await loadOrder(req.params.orderId);
  const inv = order.invoice_id ? await coinvello("GET", `/invoices/${order.invoice_id}`) : null;
  res.send(`Order ${order.id}: ${inv?.status ?? "unknown"} (local: ${order.status})`);
});

app.listen(3000, () => console.log(`listening on ${APP_URL} (API ${API})`));
