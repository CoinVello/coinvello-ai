"""CoinVello + Django (4.x / 5.x). Single file: start-payment view + verified webhook view.

AI instructions: drop this file into an app as `payments/coinvello_views.py`, add to urls.py:
    path("pay/<str:order_id>/", coinvello_views.start_payment),
    path("webhooks/coinvello/", coinvello_views.coinvello_webhook),
    path("orders/<str:order_id>/thanks/", coinvello_views.thanks),
Read settings from env (COINVELLO_API_KEY, COINVELLO_WEBHOOK_SECRET, optional COINVELLO_API_BASE, APP_URL).
The webhook view is @csrf_exempt and reads `request.body` (raw bytes). Replace the TODO store functions
with your models (e.g. Order.objects.get / save, ProcessedWebhookEvent with a unique event_id).
Standard library only (urllib); swap for `requests` if the project already uses it.
"""
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request

from django.http import HttpResponse, HttpResponseBadRequest, HttpResponseRedirect, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_GET, require_POST

API = os.environ.get("COINVELLO_API_BASE", "https://api.coinvello.com/v1")
KEY = os.environ.get("COINVELLO_API_KEY", "")
SECRET = os.environ.get("COINVELLO_WEBHOOK_SECRET", "")
APP_URL = os.environ.get("APP_URL", "http://localhost:8000")

# --- TODO: replace with your models -----------------------------------------------------------------
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
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {KEY}")
    req.add_header("Content-Type", "application/json")
    if idempotency_key:
        req.add_header("Idempotency-Key", idempotency_key)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        payload = json.loads(e.read() or b"{}")
        raise CoinVelloError(e.code, payload.get("error", {})) from None


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


@require_POST
def start_payment(request, order_id: str):
    """1. Create a hosted checkout session and redirect the customer to it."""
    order = load_order(order_id)
    try:
        session = coinvello("POST", "/checkout-sessions", {
            "amount": order["total"],                      # decimal string; str(Decimal) is fine
            "currency": "USD",
            "accepted_assets": ["btc:bitcoin", "eth:ethereum", "usdc:polygon", "usdt:tron"],
            "order_id": order["id"],
            "success_url": f"{APP_URL}/orders/{order['id']}/thanks/",
            "cancel_url": f"{APP_URL}/orders/{order['id']}/",
            "metadata": {"order_id": order["id"]},
        }, idempotency_key=f"order-{order['id']}-checkout")
    except CoinVelloError as e:
        status = 503 if e.code == "insufficient_credits" else 502
        return HttpResponse(str(e), status=status)
    save_order({**order, "checkout_session_id": session["id"], "invoice_id": session["invoice_id"]})
    return HttpResponseRedirect(session["url"], status=303)


@csrf_exempt
@require_POST
def coinvello_webhook(request):
    """2. Raw body -> verify -> dedupe -> fulfil on invoice.paid. Answer 2xx within 10 s."""
    try:
        event = verify_coinvello_signature(request.body, request.headers.get("CoinVello-Signature", ""), SECRET)
    except ValueError as e:
        return HttpResponseBadRequest(f"Webhook error: {e}")
    if event["id"] in PROCESSED:                            # use a unique DB constraint in production
        return JsonResponse({"received": True})
    inv = event["data"]["object"]
    order = load_order(inv["order_id"]) if inv.get("order_id") else None
    if event["type"] == "invoice.paid" and order:
        save_order({**order, "status": "paid"})            # fulfil here (or hand off to Celery/RQ)
    elif event["type"] in ("invoice.underpaid", "invoice.overpaid", "invoice.expired") and order:
        save_order({**order, "status": event["type"].split(".")[1]})
    PROCESSED.add(event["id"])
    return JsonResponse({"received": True})


@require_GET
def thanks(request, order_id: str):
    """3. Success page: show live status, never mark paid here."""
    order = load_order(order_id)
    inv = coinvello("GET", f"/invoices/{order['invoice_id']}") if order.get("invoice_id") else None
    return JsonResponse({"order": order["id"], "invoice_status": inv["status"] if inv else None, "local_status": order["status"]})
