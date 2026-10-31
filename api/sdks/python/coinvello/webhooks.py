"""Webhook signature verification.

Header:  CoinVello-Signature: t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>]
Signed:  b"<t>." + raw_body, HMAC-SHA256 keyed with the endpoint secret (whsec_...).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional, Union

from .errors import SignatureVerificationError

DEFAULT_TOLERANCE = 300


def _to_bytes(body: Union[str, bytes, bytearray]) -> bytes:
    if isinstance(body, str):
        return body.encode("utf-8")
    return bytes(body)


def compute_signature(raw_body: Union[str, bytes], secret: str, timestamp: int) -> str:
    return hmac.new(secret.encode("utf-8"), f"{timestamp}.".encode("ascii") + _to_bytes(raw_body), hashlib.sha256).hexdigest()


def sign_payload(raw_body: Union[str, bytes], secret: str, timestamp: Optional[int] = None) -> str:
    """Build a CoinVello-Signature header value (useful in tests)."""
    ts = int(time.time()) if timestamp is None else timestamp
    return f"t={ts},v1={compute_signature(raw_body, secret, ts)}"


def construct_event(
    raw_body: Union[str, bytes],
    signature_header: Optional[str],
    secret: str,
    tolerance: int = DEFAULT_TOLERANCE,
    now: Optional[int] = None,
) -> Dict[str, Any]:
    """Verify a delivery and return the parsed event dict.

    Pass the *raw* request body (``request.get_data()`` in Flask, ``await request.body()`` in
    FastAPI/Starlette, ``request.body`` in Django) - never a re-serialised JSON object.
    """
    if not signature_header:
        raise SignatureVerificationError("Missing CoinVello-Signature header")
    if not secret:
        raise SignatureVerificationError("Missing webhook secret")

    timestamp = 0
    signatures = []
    for part in signature_header.split(","):
        key, sep, value = part.strip().partition("=")
        if not sep:
            continue
        if key == "t":
            try:
                timestamp = int(value)
            except ValueError:
                timestamp = 0
        elif key == "v1":
            signatures.append(value)

    if timestamp <= 0:
        raise SignatureVerificationError("Malformed signature header: missing timestamp")
    if not signatures:
        raise SignatureVerificationError("Malformed signature header: no v1 signature")
    current = int(time.time()) if now is None else now
    if abs(current - timestamp) > tolerance:
        raise SignatureVerificationError("Timestamp outside the tolerance window")

    expected = compute_signature(raw_body, secret, timestamp)
    if not any(hmac.compare_digest(expected, sig) for sig in signatures):
        raise SignatureVerificationError("No signatures found matching the expected signature for payload")

    try:
        event = json.loads(_to_bytes(raw_body).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise SignatureVerificationError("Payload is not valid JSON") from None
    if not isinstance(event, dict):
        raise SignatureVerificationError("Payload is not a JSON object")
    return event


class Webhooks:
    """Namespace mirroring the other SDKs: ``Webhooks.construct_event(...)``."""

    construct_event = staticmethod(construct_event)
    sign_payload = staticmethod(sign_payload)
    compute_signature = staticmethod(compute_signature)
