/**
 * Create an invoice, simulate a payment (test mode), and verify a webhook signature locally.
 *
 *   COINVELLO_API_KEY=cv_test_... COINVELLO_BASE_URL=http://localhost:4242/v1 npm run example
 */
import { CoinVello, CoinVelloError } from "../src/index.js";

const cv = new CoinVello(process.env.COINVELLO_API_KEY ?? "cv_test_example", {
  baseUrl: process.env.COINVELLO_BASE_URL, // omit for production
});

try {
  const invoice = await cv.invoices.create(
    {
      amount: "49.99",
      currency: "USD",
      accepted_assets: ["btc:bitcoin", "usdc:polygon"],
      order_id: "WC-10042",
      success_url: "https://shop.example.com/thanks",
      metadata: { woocommerce_order_id: "10042" },
    },
    { idempotencyKey: "order-10042-invoice" },
  );
  console.log("invoice", invoice.id, invoice.status, invoice.hosted_url);
  for (const po of invoice.payment_options) console.log(`  pay ${po.amount} ${po.symbol} -> ${po.address}`);

  if (!cv.livemode) {
    const { invoice: after } = await cv.test.simulatePayment({ invoice_id: invoice.id, asset: "usdc:polygon", confirmations: 64 });
    console.log("after simulation:", after.status);
  }

  // Webhook verification round-trip (what your HTTP handler does)
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_1", object: "event", type: "invoice.paid", data: { object: invoice } });
  const header = cv.webhooks.sign(body, secret);
  const event = cv.webhooks.constructEvent(body, header, secret);
  console.log("verified event", event.type);

  for await (const inv of cv.invoices.list({ limit: 5 })) console.log("listed", inv.id, inv.status);
} catch (e) {
  if (e instanceof CoinVelloError) console.error(`CoinVello ${e.type}/${e.code}: ${e.message} (request ${e.requestId})`);
  else throw e;
}
