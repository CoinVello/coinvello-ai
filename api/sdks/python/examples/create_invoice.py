"""Create an invoice, simulate a payment (test mode) and verify a webhook signature locally.

    COINVELLO_API_KEY=cv_test_x COINVELLO_BASE_URL=http://localhost:4242/v1 python examples/create_invoice.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from coinvello import CoinVello, CoinVelloError, Webhooks  # noqa: E402

cv = CoinVello(
    os.environ.get("COINVELLO_API_KEY", "cv_test_example"),
    base_url=os.environ.get("COINVELLO_BASE_URL", "https://api.coinvello.com/v1"),
)

try:
    invoice = cv.invoices.create(
        amount="49.99",
        currency="USD",
        accepted_assets=["btc:bitcoin", "usdc:polygon"],
        order_id="WC-10042",
        success_url="https://shop.example.com/thanks",
        metadata={"woocommerce_order_id": "10042"},
        idempotency_key="order-10042-invoice",
    )
    print("invoice", invoice["id"], invoice["status"], invoice["hosted_url"])
    for po in invoice["payment_options"]:
        print(f"  pay {po['amount']} {po['symbol']} -> {po['address']}")

    if not cv.livemode:
        result = cv.test.simulate_payment(invoice["id"], asset="usdc:polygon", confirmations=64)
        print("after simulation:", result["invoice"]["status"])

    secret = "whsec_test_secret"
    body = json.dumps({"id": "evt_1", "object": "event", "type": "invoice.paid", "data": {"object": invoice}})
    header = Webhooks.sign_payload(body, secret)
    event = cv.webhooks.construct_event(body, header, secret)
    print("verified event", event["type"])

    for inv in cv.invoices.list(limit=5).auto_paging_iter():
        print("listed", inv["id"], inv["status"])
except CoinVelloError as e:
    print(f"CoinVello error: {e}", file=sys.stderr)
    sys.exit(1)
