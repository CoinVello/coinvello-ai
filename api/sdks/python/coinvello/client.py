from __future__ import annotations

import json
import platform
import random
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, Iterator, Optional, Tuple, TypedDict

from . import webhooks as _webhooks
from .errors import ApiError, CoinVelloError, ConnectionError

DEFAULT_BASE_URL = "https://api.coinvello.com/v1"
DEFAULT_API_VERSION = "2026-10-01"
SDK_VERSION = "0.1.0"

JSON = Dict[str, Any]


class _InvoiceTaxRequired(TypedDict):
    amount: str


class InvoiceTax(_InvoiceTaxRequired, total=False):
    """The tax portion of a sale, as you computed it (``tax=`` on ``invoices.create``).

    ``amount`` is a decimal STRING in the invoice currency and is already included in the invoice
    ``amount``. ``rate`` is a fraction string (``"0.19"``). ``jurisdiction`` is a region code you
    choose (``"DE"``, ``"US-CA"``), never anything about the payer.
    """

    rate: Optional[str]
    label: Optional[str]
    jurisdiction: Optional[str]


class ExportPeriod(TypedDict):
    """``start`` inclusive, ``end`` exclusive, in the export's timezone: a date or a date-time."""

    start: str
    end: str


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Surface 3xx responses as HTTPError instead of following them (so the API key is never forwarded)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


class _Http:
    def __init__(self, api_key: str, base_url: str, api_version: str, timeout: float, max_retries: int, user_agent: Optional[str]) -> None:
        if not re.match(r"^cv_(live|test)_", api_key or ""):
            raise ValueError("CoinVello api_key must start with cv_live_ or cv_test_")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.api_version = api_version
        self.timeout = timeout
        self.max_retries = max_retries
        self.user_agent = user_agent or f"coinvello-python/{SDK_VERSION} (python {platform.python_version()})"

    @property
    def livemode(self) -> bool:
        return self.api_key.startswith("cv_live_")

    def request(self, method: str, path: str, body: Optional[JSON] = None, query: Optional[Dict[str, Any]] = None, idempotency_key: Optional[str] = None) -> JSON:
        url = self.base_url + path
        if query:
            clean = {k: v for k, v in query.items() if v is not None}
            if clean:
                url += "?" + urllib.parse.urlencode(clean)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            "User-Agent": self.user_agent,
            "CoinVello-Version": self.api_version,
        }
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if method == "POST":
            headers["Idempotency-Key"] = idempotency_key or str(uuid.uuid4())

        attempt = 0
        while True:
            attempt += 1
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    status = resp.status
                    text = resp.read().decode("utf-8")
                    retry_after = resp.headers.get("Retry-After")
            except urllib.error.HTTPError as e:
                status = e.code
                text = e.read().decode("utf-8", errors="replace")
                retry_after = e.headers.get("Retry-After") if e.headers else None
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                if attempt <= self.max_retries:
                    time.sleep(self._backoff(attempt))
                    continue
                raise ConnectionError(f"Request to {path} failed: {e}") from e

            if status == 204:
                return {}
            try:
                payload = json.loads(text) if text else {}
            except ValueError:
                payload = {"error": {"type": "api_error", "code": "invalid_json", "message": text[:200], "request_id": None}}

            if 200 <= status < 300:
                return payload

            err = CoinVelloError.from_response(status, payload, retry_after)
            retryable = status >= 500 or status == 429 or (status == 409 and err.code == "idempotency_key_in_progress")
            if retryable and attempt <= self.max_retries:
                time.sleep(err.retry_after if err.retry_after else self._backoff(attempt))
                continue
            raise err

    def request_raw(self, method: str, path: str, query: Optional[Dict[str, Any]] = None) -> Tuple[int, Any, bytes]:
        """Authenticated request that returns ``(status, headers, body_bytes)`` and does NOT follow redirects.

        2xx and 3xx come back as-is (a 3xx has an empty body and a ``Location`` header); anything else
        is mapped to a ``CoinVelloError`` and retried like ``request``.
        """
        url = self.base_url + path
        if query:
            clean = {k: v for k, v in query.items() if v is not None}
            if clean:
                url += "?" + urllib.parse.urlencode(clean)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "*/*",
            "User-Agent": self.user_agent,
            "CoinVello-Version": self.api_version,
        }
        opener = urllib.request.build_opener(_NoRedirect)
        attempt = 0
        while True:
            attempt += 1
            req = urllib.request.Request(url, method=method, headers=headers)
            try:
                with opener.open(req, timeout=self.timeout) as resp:
                    return resp.status, resp.headers, resp.read()
            except urllib.error.HTTPError as e:
                status, resp_headers, body = e.code, e.headers, e.read()
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                if attempt <= self.max_retries:
                    time.sleep(self._backoff(attempt))
                    continue
                raise ConnectionError(f"Request to {path} failed: {e}") from e

            if 300 <= status < 400:
                return status, resp_headers, b""
            try:
                payload = json.loads(body.decode("utf-8")) if body else {}
            except ValueError:
                payload = {"error": {"type": "api_error", "code": "invalid_json", "message": body[:200].decode("utf-8", errors="replace"), "request_id": None}}
            retry_after = resp_headers.get("Retry-After") if resp_headers else None
            err = CoinVelloError.from_response(status, payload, retry_after)
            if (status >= 500 or status == 429) and attempt <= self.max_retries:
                time.sleep(err.retry_after if err.retry_after else self._backoff(attempt))
                continue
            raise err

    def fetch_signed(self, url: str) -> bytes:
        """GET a signed file URL (e.g. an export's ``download_url``). Sends NO Authorization header."""
        if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
            raise ApiError("Refusing to download from a non-http(s) URL", type="api_error", code="invalid_download_url")
        attempt = 0
        while True:
            attempt += 1
            req = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return resp.read()
            except urllib.error.HTTPError as e:
                if e.code >= 500 and attempt <= self.max_retries:
                    time.sleep(self._backoff(attempt))
                    continue
                raise ApiError(f"Downloading the file failed: HTTP {e.code} (the signed URL may have expired; retrieve the export again)", type="api_error", code="download_failed", http_status=e.code) from e
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                if attempt <= self.max_retries:
                    time.sleep(self._backoff(attempt))
                    continue
                raise ConnectionError(f"Downloading the file failed: {e}") from e

    @staticmethod
    def _backoff(attempt: int) -> float:
        base = min(0.5 * (2 ** (attempt - 1)), 8.0)
        return base / 2 + random.random() * base / 2

    def get(self, path: str, **query: Any) -> JSON:
        return self.request("GET", path, query=query or None)

    def post(self, path: str, body: Optional[JSON] = None, idempotency_key: Optional[str] = None) -> JSON:
        return self.request("POST", path, body=body if body is not None else {}, idempotency_key=idempotency_key)

    def patch(self, path: str, body: JSON) -> JSON:
        return self.request("PATCH", path, body=body)

    def put(self, path: str, body: JSON) -> JSON:
        return self.request("PUT", path, body=body)

    def delete(self, path: str) -> JSON:
        return self.request("DELETE", path)


class ListPage(dict):
    """A page (``data``, ``has_more``, ``next_cursor``) with ``auto_paging_iter()``."""

    def __init__(self, http: _Http, path: str, params: Dict[str, Any], page: JSON) -> None:
        super().__init__(page)
        self._http, self._path, self._params = http, path, params

    @property
    def data(self):
        return self.get("data", [])

    def next_page(self) -> Optional["ListPage"]:
        if not self.get("has_more") or not self.get("next_cursor"):
            return None
        params = dict(self._params, cursor=self["next_cursor"])
        return ListPage(self._http, self._path, self._params, self._http.get(self._path, **params))

    def auto_paging_iter(self) -> Iterator[JSON]:
        page: Optional[ListPage] = self
        while page is not None:
            yield from page.data
            page = page.next_page()


def _clean(**kwargs: Any) -> JSON:
    return {k: v for k, v in kwargs.items() if v is not None}


class _Resource:
    def __init__(self, http: _Http) -> None:
        self._http = http

    def _list(self, path: str, **params: Any) -> ListPage:
        params = _clean(**params)
        return ListPage(self._http, path, params, self._http.get(path, **params))


def _query(**params: Any) -> Dict[str, Any]:
    """Drop ``None`` and render booleans as ``true``/``false`` for the query string."""
    return {k: ("true" if v else "false") if isinstance(v, bool) else v for k, v in params.items() if v is not None}


class Invoices(_Resource):
    def create(self, *, idempotency_key: Optional[str] = None, **params: Any) -> JSON:
        """Create an invoice. ``params`` are the body fields (``amount`` as a decimal string, ``currency``, ...).

        ``tax`` (optional, :class:`InvoiceTax`) records the tax portion you computed, for bookkeeping and
        exports; ``amount`` is a decimal STRING already included in the invoice amount::

            cv.invoices.create(amount="49.99", currency="EUR",
                               tax={"amount": "7.98", "rate": "0.19", "label": "VAT 19%", "jurisdiction": "DE"})
        """
        return self._http.post("/invoices", params, idempotency_key)

    def get(self, invoice_id: str) -> JSON:
        return self._http.get(f"/invoices/{invoice_id}")

    def list(self, **params: Any) -> ListPage:
        return self._list("/invoices", **params)

    def update(self, invoice_id: str, **params: Any) -> JSON:
        return self._http.patch(f"/invoices/{invoice_id}", params)

    def cancel(self, invoice_id: str, idempotency_key: Optional[str] = None) -> JSON:
        return self._http.post(f"/invoices/{invoice_id}/cancel", {}, idempotency_key)

    def expire(self, invoice_id: str, idempotency_key: Optional[str] = None) -> JSON:
        return self._http.post(f"/invoices/{invoice_id}/expire", {}, idempotency_key)

    def list_payments(self, invoice_id: str, **params: Any) -> ListPage:
        return self._list(f"/invoices/{invoice_id}/payments", **params)


class Payments(_Resource):
    def get(self, payment_id: str) -> JSON:
        return self._http.get(f"/payments/{payment_id}")

    def list(self, **params: Any) -> ListPage:
        return self._list("/payments", **params)


class Wallets(_Resource):
    def create(self, *, idempotency_key: Optional[str] = None, **params: Any) -> JSON:
        return self._http.post("/wallets", params, idempotency_key)

    def get(self, wallet_id: str) -> JSON:
        return self._http.get(f"/wallets/{wallet_id}")

    def list(self, **params: Any) -> ListPage:
        return self._list("/wallets", **params)

    def update(self, wallet_id: str, **params: Any) -> JSON:
        return self._http.patch(f"/wallets/{wallet_id}", params)

    def archive(self, wallet_id: str) -> JSON:
        return self._http.delete(f"/wallets/{wallet_id}")

    def create_verification(self, wallet_id: str) -> JSON:
        return self._http.post(f"/wallets/{wallet_id}/verification")

    def verify(self, wallet_id: str, signature: str, challenge_id: Optional[str] = None) -> JSON:
        return self._http.post(f"/wallets/{wallet_id}/verify", _clean(signature=signature, challenge_id=challenge_id))

    def list_addresses(self, wallet_id: str, **params: Any) -> ListPage:
        return self._list(f"/wallets/{wallet_id}/addresses", **params)


class WebhookEndpoints(_Resource):
    def create(self, *, idempotency_key: Optional[str] = None, **params: Any) -> JSON:
        return self._http.post("/webhooks", params, idempotency_key)

    def get(self, webhook_id: str) -> JSON:
        return self._http.get(f"/webhooks/{webhook_id}")

    def list(self, **params: Any) -> ListPage:
        return self._list("/webhooks", **params)

    def update(self, webhook_id: str, **params: Any) -> JSON:
        return self._http.patch(f"/webhooks/{webhook_id}", params)

    def delete(self, webhook_id: str) -> JSON:
        return self._http.delete(f"/webhooks/{webhook_id}")

    def rotate_secret(self, webhook_id: str, grace_period_seconds: Optional[int] = None) -> JSON:
        return self._http.post(f"/webhooks/{webhook_id}/rotate_secret", _clean(grace_period_seconds=grace_period_seconds))

    def test(self, webhook_id: str, event_type: str = "ping") -> JSON:
        return self._http.post(f"/webhooks/{webhook_id}/test", {"event_type": event_type})

    def list_deliveries(self, webhook_id: str, **params: Any) -> ListPage:
        return self._list(f"/webhooks/{webhook_id}/deliveries", **params)

    def retry_delivery(self, webhook_id: str, delivery_id: str) -> JSON:
        return self._http.post(f"/webhooks/{webhook_id}/deliveries/{delivery_id}/retry")

    # signature helpers
    construct_event = staticmethod(_webhooks.construct_event)
    sign_payload = staticmethod(_webhooks.sign_payload)


class Credits(_Resource):
    def balance(self) -> JSON:
        """``balance`` (= ``available`` + ``reserved``, never negative), ``available`` (free to spend) and
        ``reserved`` (estimated fees of open invoices paid with credits), plus ``low_balance_threshold``,
        ``estimated_payments_remaining``, ``expiring_soon`` and ``auto_topup``."""
        return self._http.get("/credits/balance")

    def bundles(self) -> JSON:
        return self._http.get("/credits/bundles")

    def purchase(self, bundle_id: str, *, pay_asset: Optional[str] = None, pay_chain: Optional[str] = None, payment_method: Optional[str] = None, idempotency_key: Optional[str] = None, **params: Any) -> JSON:
        """Buy a bundle with crypto (pay_asset + pay_chain) or a saved card (payment_method="pm_...")."""
        return self._http.post("/credits/purchases", _clean(bundle_id=bundle_id, pay_asset=pay_asset, pay_chain=pay_chain, payment_method=payment_method, **params), idempotency_key)

    def payment_methods(self) -> JSON:
        """Saved cards (added in the dashboard; API keys cannot add cards)."""
        return self._http.get("/credits/payment_methods")

    def get_purchase(self, purchase_id: str) -> JSON:
        return self._http.get(f"/credits/purchases/{purchase_id}")

    def list_purchases(self, **params: Any) -> ListPage:
        return self._list("/credits/purchases", **params)

    def cancel_purchase(self, purchase_id: str) -> JSON:
        return self._http.post(f"/credits/purchases/{purchase_id}/cancel")

    def ledger(self, **params: Any) -> ListPage:
        return self._list("/credits/ledger", **params)

    def set_auto_topup(self, **params: Any) -> JSON:
        return self._http.put("/credits/auto_topup", params)


class Rates(_Resource):
    def list(self, base: str = "USD", assets: Optional[list] = None) -> JSON:
        return self._http.get("/rates", base=base, assets=",".join(assets) if assets else None)

    def quote(self, **params: Any) -> JSON:
        return self._http.post("/rates/quotes", params)

    def lock(self, quote_id: str, duration_seconds: Optional[int] = None, idempotency_key: Optional[str] = None) -> JSON:
        return self._http.post("/rates/locks", _clean(quote_id=quote_id, duration_seconds=duration_seconds), idempotency_key)

    def get_lock(self, lock_id: str) -> JSON:
        return self._http.get(f"/rates/locks/{lock_id}")


class Conversions(_Resource):
    def quote(self, **params: Any) -> JSON:
        return self._http.post("/conversions/quotes", params)

    def create(self, quote_id: str, metadata: Optional[Dict[str, str]] = None, idempotency_key: Optional[str] = None) -> JSON:
        return self._http.post("/conversions", _clean(quote_id=quote_id, metadata=metadata), idempotency_key)

    def get(self, conversion_id: str) -> JSON:
        return self._http.get(f"/conversions/{conversion_id}")

    def list(self, **params: Any) -> ListPage:
        return self._list("/conversions", **params)

    def submit(self, conversion_id: str, **submission: Any) -> JSON:
        return self._http.post(f"/conversions/{conversion_id}/submit", submission)

    def cancel(self, conversion_id: str) -> JSON:
        return self._http.post(f"/conversions/{conversion_id}/cancel")


class Offramp(_Resource):
    def providers(self) -> JSON:
        return self._http.get("/offramp/providers")

    def connect_account(self, *, idempotency_key: Optional[str] = None, **params: Any) -> JSON:
        return self._http.post("/offramp/accounts", params, idempotency_key)

    def get_account(self, account_id: str) -> JSON:
        return self._http.get(f"/offramp/accounts/{account_id}")

    def list_accounts(self, **params: Any) -> ListPage:
        return self._list("/offramp/accounts", **params)

    def disconnect_account(self, account_id: str) -> JSON:
        return self._http.delete(f"/offramp/accounts/{account_id}")

    def quote(self, **params: Any) -> JSON:
        return self._http.post("/offramp/quotes", params)

    def create_payout(self, quote_id: str, from_wallet_id: str, idempotency_key: Optional[str] = None, **params: Any) -> JSON:
        return self._http.post("/offramp/payouts", _clean(quote_id=quote_id, from_wallet_id=from_wallet_id, **params), idempotency_key)

    def get_payout(self, payout_id: str) -> JSON:
        return self._http.get(f"/offramp/payouts/{payout_id}")

    def list_payouts(self, **params: Any) -> ListPage:
        return self._list("/offramp/payouts", **params)

    def submit_payout(self, payout_id: str, **submission: Any) -> JSON:
        return self._http.post(f"/offramp/payouts/{payout_id}/submit", submission)

    def cancel_payout(self, payout_id: str) -> JSON:
        return self._http.post(f"/offramp/payouts/{payout_id}/cancel")


class CheckoutSessions(_Resource):
    def create(self, *, idempotency_key: Optional[str] = None, **params: Any) -> JSON:
        return self._http.post("/checkout-sessions", params, idempotency_key)

    def get(self, session_id: str, expand_invoice: bool = False) -> JSON:
        return self._http.get(f"/checkout-sessions/{session_id}", expand="invoice" if expand_invoice else None)

    def list(self, **params: Any) -> ListPage:
        return self._list("/checkout-sessions", **params)

    def expire(self, session_id: str) -> JSON:
        return self._http.post(f"/checkout-sessions/{session_id}/expire")

    @staticmethod
    def fetch_public(session_id: str, base_url: str = DEFAULT_BASE_URL, timeout: float = 15.0) -> JSON:
        """Public, unauthenticated payer view (no API key is sent)."""
        url = f"{base_url.rstrip('/')}/checkout-sessions/{urllib.parse.quote(session_id)}/public"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    @staticmethod
    def events_url(session_id: str, base_url: str = DEFAULT_BASE_URL) -> str:
        return f"{base_url.rstrip('/')}/checkout-sessions/{urllib.parse.quote(session_id)}/events"


class Refunds(_Resource):
    def create(self, *, idempotency_key: Optional[str] = None, **params: Any) -> JSON:
        return self._http.post("/refunds", params, idempotency_key)

    def get(self, refund_id: str) -> JSON:
        return self._http.get(f"/refunds/{refund_id}")

    def list(self, **params: Any) -> ListPage:
        return self._list("/refunds", **params)

    def submit(self, refund_id: str, **submission: Any) -> JSON:
        return self._http.post(f"/refunds/{refund_id}/submit", submission)

    def cancel(self, refund_id: str) -> JSON:
        return self._http.post(f"/refunds/{refund_id}/cancel")


class Events(_Resource):
    def get(self, event_id: str) -> JSON:
        return self._http.get(f"/events/{event_id}")

    def list(self, **params: Any) -> ListPage:
        return self._list("/events", **params)


class Records(_Resource):
    """The account's book of record: immutable rows valued in the reporting currency (docs/10-records-and-tax.md)."""

    def list(self, **params: Any) -> ListPage:
        """Newest first. Filters: ``type``, ``asset``, ``chain``, ``invoice_id``, ``order_id``, ``tx_hash``,
        ``occurred_gte``, ``occurred_lte``, ``currency``, ``include_simulated`` (test mode), ``limit``, ``cursor``."""
        return self._list("/records", **_query(**params))

    def retrieve(self, record_id: str, **params: Any) -> JSON:
        """One record; ``currency`` re-values ``value`` into another reporting currency."""
        return self._http.get(f"/records/{record_id}", **_query(**params))

    get = retrieve  # same verb as the other resources

    def summary(
        self,
        period_start: str,
        period_end: str,
        currency: Optional[str] = None,
        timezone: Optional[str] = None,
        group_by: Optional[str] = None,
        include_simulated: Optional[bool] = None,
    ) -> JSON:
        """Totals over ``occurred_at``: ``period_start`` inclusive, ``period_end`` exclusive (a date or a date-time,
        read in ``timezone``). ``group_by`` is month, asset, chain, type or address. Amounts are decimal strings."""
        return self._http.get(
            "/records/summary",
            **_query(period_start=period_start, period_end=period_end, currency=currency, timezone=timezone, group_by=group_by, include_simulated=include_simulated),
        )


class Exports(_Resource):
    """CSV, Excel and JSON exports of records or any dataset. Files are kept 7 days."""

    def create(
        self,
        *,
        format: str,  # noqa: A002 - mirrors the API field: csv, xlsx or json
        dataset: str = "records",
        preset: Optional[str] = None,
        period: Optional[ExportPeriod] = None,
        timezone: Optional[str] = None,
        currency: Optional[str] = None,
        include_simulated: Optional[bool] = None,
        metadata: Optional[Dict[str, str]] = None,
        idempotency_key: Optional[str] = None,
        **params: Any,
    ) -> JSON:
        """Start an export; small ones come back ``ready``. ``period`` is ``{"start": "2026-07-01", "end": "2026-10-01"}``
        (end exclusive) or omitted for the entire history. ``dataset``: records, invoices, payments, refunds, sweeps,
        credit_ledger, credit_purchases, conversions, offramp_payouts or all. ``preset`` (records + csv only for the
        vendor ones): generic, journal, quickbooks, xero, koinly, cointracker, coinledger.
        Status: queued, processing, ready, failed, expired."""
        body = _clean(dataset=dataset, format=format, preset=preset, period=period, timezone=timezone, currency=currency, include_simulated=include_simulated, metadata=metadata, **params)
        return self._http.post("/exports", body, idempotency_key)

    def list(self, **params: Any) -> ListPage:
        """Newest first. Filters: ``status``, ``dataset``, ``limit``, ``cursor``."""
        return self._list("/exports", **_query(**params))

    def retrieve(self, export_id: str) -> JSON:
        return self._http.get(f"/exports/{export_id}")

    get = retrieve  # same verb as the other resources

    def delete(self, export_id: str) -> JSON:
        """Remove the file before its 7 days are up; the records are untouched."""
        return self._http.delete(f"/exports/{export_id}")

    def download(self, export_id: str) -> bytes:
        """The file's bytes. Raises ``InvalidRequestError`` (409 ``export_not_ready`` / ``export_expired`` /
        ``export_failed``) unless the export is ``ready``.

        The API answers either 200 with the file or 302 to a signed ``download_url``; the redirect is followed
        without the API key.
        """
        path = f"/exports/{export_id}/download"
        status, headers, body = self._http.request_raw("GET", path)
        if 300 <= status < 400:
            location = headers.get("Location") if headers else None
            if not location:
                raise ApiError("Download redirect without a Location header", type="api_error", code="invalid_redirect", http_status=status)
            return self._http.fetch_signed(urllib.parse.urljoin(self._http.base_url + path, location))
        return body


class Assets(_Resource):
    def list(self) -> JSON:
        return self._http.get("/assets")


class Test(_Resource):
    def simulate_payment(self, invoice_id: str, *, idempotency_key: Optional[str] = None, **params: Any) -> JSON:
        """Test mode only. ``invoice_id`` may be an invoice (inv_) or a credit purchase (cpu_)."""
        return self._http.post("/test/simulate_payment", _clean(invoice_id=invoice_id, **params), idempotency_key)


class CoinVello:
    """Entry point.

    cv = CoinVello("cv_test_...", base_url="http://localhost:4242/v1")
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        api_version: str = DEFAULT_API_VERSION,
        timeout: float = 30.0,
        max_retries: int = 3,
        user_agent: Optional[str] = None,
    ) -> None:
        http = _Http(api_key, base_url, api_version, timeout, max_retries, user_agent)
        self.livemode = http.livemode
        self.invoices = Invoices(http)
        self.payments = Payments(http)
        self.wallets = Wallets(http)
        self.webhooks = WebhookEndpoints(http)
        self.credits = Credits(http)
        self.rates = Rates(http)
        self.conversions = Conversions(http)
        self.offramp = Offramp(http)
        self.checkout_sessions = CheckoutSessions(http)
        self.refunds = Refunds(http)
        self.events = Events(http)
        self.records = Records(http)
        self.exports = Exports(http)
        self.assets = Assets(http)
        self.test = Test(http)
