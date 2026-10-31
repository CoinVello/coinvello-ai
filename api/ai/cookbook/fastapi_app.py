"""CoinVello + FastAPI (Python 3.10+). Single file: start-payment route + verified webhook.

AI instructions: `pip install fastapi uvicorn httpx`, set the env vars below, mount the two routes in the
existing app (or run this file as is), and replace the TODO store functions with the project's ORM.
The webhook handler must read `await request.body()` (raw bytes); do not declare a Pydantic body model
for it, because re-serialised JSON breaks the HMAC.

Env:  COINVELLO_API_KEY=cv_test_...  COINVELLO_WEBHOOK_SECRET=whsec_...
      COINVELLO_API_BASE=https://api.coinvello.com/v1 (or http://localhost:4242/v1 for the mock)  APP_URL=http://localhost:3000
Run:  uvicorn fastapi_app:app --port 3000   ->  POST http://localhost:3000/pay/ORDER-1
Test: see README.md (register http://localhost:3000/webhooks/coinvello as webhook, simulate a payment).
"""
import hashlib
import hmac
import json
import os
import time

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, RedirectResponse

API = os.environ.get("COINVELLO_API_BASE", "https://api.coinvello.com/v1")
KEY = os.environ["COINVELLO_API_KEY"]
SECRET = os.environ.get("COINVELLO_WEBHOOK_SECRET", "")
APP_URL = os.environ.get("APP_URL", "http://localhost:3000")

app = FastAPI()

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
        self.status, self.code, self.request_id = status, error.get("code"), error.get("request_id")


async def coinvello(method: str, path: str, body: dict | None = None, idempotency_key: str | None = None) -> dict:
    headers = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.request(method, API + path, json=body, headers=headers)
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


@app.post("/pay/{order_id}")
async def start_payment(order_id: str):
    """1. Create a hosted checkout session and redirect the customer to it."""
    order = load_order(order_id)
    try:
        session = await coinvello("POST", "/checkout-sessions", {
            "amount": order["total"],                      # decimal string, never a float
            "currency": "USD",
            "accepted_assets": ["btc:bitcoin", "eth:ethereum", "usdc:polygon", "usdt:tron"],
            "order_id": order["id"],
            "success_url": f"{APP_URL}/orders/{order['id']}/thanks",
            "cancel_url": f"{APP_URL}/orders/{order['id']}",
            "metadata": {"order_id": order["id"]},
        }, idempotency_key=f"order-{order['id']}-checkout")
    except CoinVelloError as e:
        if e.code == "insufficient_credits":
            raise HTTPException(503, "Crypto payments temporarily unavailable")
        raise HTTPException(502, str(e))
    save_order({**order, "checkout_session_id": session["id"], "invoice_id": session["invoice_id"]})
    return RedirectResponse(session["url"], status_code=303)


@app.post("/webhooks/coinvello")
async def coinvello_webhook(request: Request):
    """2. Raw body -> verify -> dedupe -> fulfil on invoice.paid. Answer 2xx within 10 s."""
    raw = await request.body()
    try:
        event = verify_coinvello_signature(raw, request.headers.get("CoinVello-Signature", ""), SECRET)
    except ValueError as e:
        return PlainTextResponse(f"Webhook error: {e}", status_code=400)
    if event["id"] in PROCESSED:
        return {"received": True}
    inv = event["data"]["object"]
    order = load_order(inv["order_id"]) if inv.get("order_id") else None
    if event["type"] == "invoice.paid" and order:
        save_order({**order, "status": "paid"})            # fulfil here (or enqueue a background task)
    elif event["type"] in ("invoice.underpaid", "invoice.overpaid", "invoice.expired") and order:
        save_order({**order, "status": event["type"].split(".")[1]})
    PROCESSED.add(event["id"])
    return {"received": True}


@app.get("/orders/{order_id}/thanks")
async def thanks(order_id: str):
    """3. Success page: show live status, never mark paid here."""
    order = load_order(order_id)
    inv = await coinvello("GET", f"/invoices/{order['invoice_id']}") if order.get("invoice_id") else None
    return {"order": order["id"], "invoice_status": inv["status"] if inv else None, "local_status": order["status"]}
