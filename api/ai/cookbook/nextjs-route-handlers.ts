// CoinVello + Next.js (app router, Next 14/15, TypeScript). Two route handlers in one file for reading;
// in a real project split them as noted below.
//
// AI instructions:
//   app/api/pay/[orderId]/route.ts        -> export the POST handler `startPayment` as `POST`
//   app/api/webhooks/coinvello/route.ts   -> export the POST handler `coinvelloWebhook` as `POST`
//   lib/coinvello.ts                      -> the helpers (coinvello(), verifyCoinVelloSignature())
// Set env in .env.local: COINVELLO_API_KEY, COINVELLO_WEBHOOK_SECRET, optional COINVELLO_API_BASE, NEXT_PUBLIC_APP_URL.
// Use `await req.text()` for the webhook body (never req.json() first). Route handlers run on the
// Node runtime by default; do NOT set `runtime = "edge"` for the webhook unless you swap node:crypto for WebCrypto.
// Replace the TODO store functions with your database (Prisma, Drizzle, ...).
import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

const API = process.env.COINVELLO_API_BASE ?? "https://api.coinvello.com/v1";
const KEY = process.env.COINVELLO_API_KEY!;
const SECRET = process.env.COINVELLO_WEBHOOK_SECRET!;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

// --- TODO: replace with your database -----------------------------------------------------------
type Order = { id: string; total: string; status: string; checkout_session_id?: string; invoice_id?: string };
const orders = new Map<string, Order>();
const processed = new Set<string>();
async function loadOrder(id: string): Promise<Order> { return orders.get(id) ?? { id, total: "49.99", status: "unpaid" }; }
async function saveOrder(o: Order) { orders.set(o.id, o); }
// -----------------------------------------------------------------------------------------------

export class CoinVelloError extends Error {
  constructor(public status: number, public code: string | undefined, message: string, public requestId?: string) { super(message); }
}

export async function coinvello<T = any>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new CoinVelloError(res.status, json.error?.code, json.error?.message ?? `CoinVello ${res.status}`, json.error?.request_id);
  return json as T;
}

/** CoinVello-Signature: t=<unix>,v1=<hex>[,v1=<hex>]; HMAC-SHA256 over "<t>.<raw body>"; 300 s tolerance. */
export function verifyCoinVelloSignature(rawBody: string, header: string | null, secret: string, toleranceSec = 300): any {
  if (!header) throw new Error("missing CoinVello-Signature");
  let t = 0; const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("="); const v = rest.join("=");
    if (k === "t") t = Number(v);
    if (k === "v1") sigs.push(v);
  }
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) throw new Error("timestamp outside tolerance");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const ok = sigs.some((s) => { const b = Buffer.from(s, "hex"); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
  if (!ok) throw new Error("signature mismatch");
  return JSON.parse(rawBody);
}

// --- app/api/pay/[orderId]/route.ts ---------------------------------------------------------------
export async function startPayment(_req: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const order = await loadOrder(orderId);
  try {
    const session = await coinvello("POST", "/checkout-sessions", {
      amount: order.total,                                           // decimal string
      currency: "USD",
      accepted_assets: ["btc:bitcoin", "eth:ethereum", "usdc:polygon", "usdt:tron"],
      order_id: order.id,
      success_url: `${APP_URL}/orders/${order.id}/thanks`,
      cancel_url: `${APP_URL}/orders/${order.id}`,
      metadata: { order_id: order.id },
    }, `order-${order.id}-checkout`);
    await saveOrder({ ...order, checkout_session_id: session.id, invoice_id: session.invoice_id });
    return NextResponse.redirect(session.url, 303);
  } catch (e) {
    if (e instanceof CoinVelloError && e.code === "insufficient_credits") {
      return NextResponse.json({ error: "Crypto payments temporarily unavailable" }, { status: 503 });
    }
    throw e;
  }
}

// --- app/api/webhooks/coinvello/route.ts ----------------------------------------------------------
export async function coinvelloWebhook(req: NextRequest) {
  const raw = await req.text();                                      // raw body, exactly as sent
  let event: any;
  try {
    event = verifyCoinVelloSignature(raw, req.headers.get("coinvello-signature"), SECRET);
  } catch (e: any) {
    return new NextResponse(`Webhook error: ${e.message}`, { status: 400 });
  }
  if (processed.has(event.id)) return NextResponse.json({ received: true });   // idempotent redelivery

  const inv = event.data.object;
  const order = inv.order_id ? await loadOrder(inv.order_id) : null;
  switch (event.type) {
    case "invoice.paid":
      if (order) await saveOrder({ ...order, status: "paid" });            // fulfil (or enqueue a job)
      break;
    case "invoice.underpaid":
    case "invoice.overpaid":
    case "invoice.expired":
      if (order) await saveOrder({ ...order, status: event.type.split(".")[1] });
      break;
  }
  processed.add(event.id);
  return NextResponse.json({ received: true });
}

// In the real files:  export { startPayment as POST }  and  export { coinvelloWebhook as POST }
