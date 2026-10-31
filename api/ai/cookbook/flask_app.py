"""CoinVello + Flask (Python 3.10+). Single file: start-payment route + verified webhook.

AI instructions: `pip install flask requests`, set the env vars below, register the blueprint (or copy the
two views) into the existing app, replace the TODO store functions with the project's ORM. Use
`request.get_data()` for the raw webhook body, never `request.get_json()` first.

Env:  COINVELLO_API_KEY=cv_test_...  COINVELLO_WEBHOOK_SECRET=whsec_...
      COINVELLO_API_BASE=https://api.coinvello.com/v1 (or http://localhost:4242/v1 for the mock)  APP_URL=http://localhost:3000
Run:  flask --app flask_app run --port 3000   ->  POST http://localhost:3000/pay/ORDER-1
Test: see README.md (register http://localhost:3000/webhooks/coinvello as webhook, simulate a payment).
"""
import hashlib
import hmac
import json
import os
import time

import requests
from flask import Blueprint, Flask, abort, jsonify, redirect, request

API = os.environ.get("COINVELLO_API_BASE", "https://api.coinvello.com/v1")
KEY = os.environ["COINVELLO_API_KEY"]
SECRET = os.environ.get("COINVELLO_WEBHOOK_SECRET", "")
APP_URL = os.environ.get("APP_URL", "http://localhost:3000")

bp = Blueprint("coinvello", __name__)

# --- TODO: replace with your database ---------------------------------------------------------------
ORDERS: dict[str, dict] = {}
PROCESSED: set[str] = set()


def load_order(order_id: str) -> dict:
    return ORDERS.setdefault(order_id, {"id": order_id, "total": "49.99", "status": "unpaid"})


def save_order(order: dict) -> None:
    ORDERS[order["id"]] = order
# ---------------------------------------------------------------------------------------------------


class CoinVelloError(Exception):
    def __init__(self, status: int, error: dict):
        super().__init__(error.get("message", f"CoinVello {status}"))
        self.status, self.code = status, error.get("code")


def coinvello(method: str, path: str, body: dict | None = None, idempotency_key: str | None = None) -> dict:
    headers = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    r = requests.request(method, API + path, json=body, headers=headers, timeout=20)
    data = r.json() if r.content else {}
    if r.status_code >= 400:
        raise CoinVelloError(r.status_code, data.get("error", {}))
    return data


def verify_coinvello_signature(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> dict:
    """CoinVello-Signature: t=<unix>,v1=<hex>[,v1=<hex>]; HMAC-SHA256 over b"<t>." + raw_body."""
    t, sigs = 0, []
    for part in (header or "").split(","):
        k, _, v = part.strip().partition("=")
        if k == "t":
            t = int(v or 0)
        elif k == "v1":
            sigs.append(v)
    if not t or abs(time.time() - t) > tolerance:
        raise ValueError("timestamp outside tolerance")
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, s) for s in sigs):
        raise ValueError("signature mismatch")
    return json.loads(raw_body)


@bp.post("/pay/<order_id>")
def start_payment(order_id: str):
    """1. Create a hosted checkout session and redirect the customer to it."""
    order = load_order(order_id)
    try:
        session = coinvello("POST", "/checkout-sessions", {
            "amount": order["total"],                      # decimal string, never a float
            "currency": "USD",
            "accepted_assets": ["btc:bitcoin", "eth:ethereum", "usdc:polygon", "usdt:tron"],
            "order_id": order["id"],
            "success_url": f"{APP_URL}/orders/{order['id']}/thanks",
            "cancel_url": f"{APP_URL}/orders/{order['id']}",
            "metadata": {"order_id": order["id"]},
        }, idempotency_key=f"order-{order['id']}-checkout")
    except CoinVelloError as e:
        abort(503 if e.code == "insufficient_credits" else 502, str(e))
    save_order({**order, "checkout_session_id": session["id"], "invoice_id": session["invoice_id"]})
    return redirect(session["url"], code=303)


@bp.post("/webhooks/coinvello")
def coinvello_webhook():
    """2. Raw body -> verify -> dedupe -> fulfil on invoice.paid. Answer 2xx within 10 s."""
    raw = request.get_data()
    try:
        event = verify_coinvello_signature(raw, request.headers.get("CoinVello-Signature", ""), SECRET)
    except ValueError as e:
        return f"Webhook error: {e}", 400
    if event["id"] in PROCESSED:
        return jsonify(received=True)
    inv = event["data"]["object"]
    order = load_order(inv["order_id"]) if inv.get("order_id") else None
    if event["type"] == "invoice.paid" and order:
        save_order({**order, "status": "paid"})            # fulfil here (or enqueue a job)
    elif event["type"] in ("invoice.underpaid", "invoice.overpaid", "invoice.expired") and order:
        save_order({**order, "status": event["type"].split(".")[1]})
    PROCESSED.add(event["id"])
    return jsonify(received=True)


@bp.get("/orders/<order_id>/thanks")
def thanks(order_id: str):
    """3. Success page: show live status, never mark paid here."""
    order = load_order(order_id)
    inv = coinvello("GET", f"/invoices/{order['invoice_id']}") if order.get("invoice_id") else None
    return jsonify(order=order["id"], invoice_status=inv["status"] if inv else None, local_status=order["status"])


app = Flask(__name__)
app.register_blueprint(bp)
