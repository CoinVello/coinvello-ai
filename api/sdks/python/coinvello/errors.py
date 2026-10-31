from __future__ import annotations

from typing import Any, Dict, Optional


class CoinVelloError(Exception):
    """Base class. Exposes the API error envelope."""

    def __init__(
        self,
        message: str,
        *,
        type: str = "api_error",
        code: str = "unknown",
        param: Optional[str] = None,
        request_id: Optional[str] = None,
        http_status: Optional[int] = None,
        details: Optional[Dict[str, Any]] = None,
        retry_after: Optional[int] = None,
    ) -> None:
        super().__init__(message)
        self.type = type
        self.code = code
        self.param = param
        self.request_id = request_id
        self.http_status = http_status
        self.details = details or {}
        self.retry_after = retry_after

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        base = super().__str__()
        return f"{self.type}/{self.code}: {base}" + (f" (request {self.request_id})" if self.request_id else "")

    @classmethod
    def from_response(cls, status: int, body: Any, retry_after: Optional[str] = None) -> "CoinVelloError":
        err = (body or {}).get("error") if isinstance(body, dict) else None
        if not isinstance(err, dict):
            err = {"type": "api_error", "code": "unknown", "message": f"HTTP {status}", "request_id": None}
        klass = _CLASSES.get(err.get("type", ""), ApiError)
        return klass(
            err.get("message", f"HTTP {status}"),
            type=err.get("type", "api_error"),
            code=err.get("code", "unknown"),
            param=err.get("param"),
            request_id=err.get("request_id"),
            http_status=status,
            details=err.get("details"),
            retry_after=int(retry_after) if retry_after and retry_after.isdigit() else None,
        )


class AuthenticationError(CoinVelloError): ...
class PermissionError(CoinVelloError): ...  # noqa: A001 - mirrors API type name
class InvalidRequestError(CoinVelloError): ...
class IdempotencyError(CoinVelloError): ...
class RateLimitError(CoinVelloError): ...
class CreditsError(CoinVelloError): ...
class ChainError(CoinVelloError): ...
class PartnerError(CoinVelloError): ...
class ApiError(CoinVelloError): ...


class ConnectionError(CoinVelloError):  # noqa: A001
    def __init__(self, message: str) -> None:
        super().__init__(message, type="connection_error", code="connection_failed")


class SignatureVerificationError(CoinVelloError):
    def __init__(self, message: str) -> None:
        super().__init__(message, type="signature_verification_error", code="signature_invalid")


_CLASSES = {
    "authentication_error": AuthenticationError,
    "permission_error": PermissionError,
    "invalid_request_error": InvalidRequestError,
    "idempotency_error": IdempotencyError,
    "rate_limit_error": RateLimitError,
    "credits_error": CreditsError,
    "chain_error": ChainError,
    "partner_error": PartnerError,
    "api_error": ApiError,
}
