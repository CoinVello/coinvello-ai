"""CoinVello API client.

    from coinvello import CoinVello
    cv = CoinVello("cv_test_...")
    invoice = cv.invoices.create(amount="49.99", currency="USD")
    event = cv.webhooks.construct_event(raw_body, signature_header, secret)
"""

from .client import CoinVello, DEFAULT_API_VERSION, DEFAULT_BASE_URL, ExportPeriod, InvoiceTax
from .errors import (
    ApiError,
    AuthenticationError,
    ChainError,
    CoinVelloError,
    ConnectionError,
    CreditsError,
    IdempotencyError,
    InvalidRequestError,
    PartnerError,
    PermissionError,
    RateLimitError,
    SignatureVerificationError,
)
from .webhooks import Webhooks, construct_event, sign_payload

__all__ = [
    "CoinVello",
    "DEFAULT_API_VERSION",
    "DEFAULT_BASE_URL",
    "InvoiceTax",
    "ExportPeriod",
    "Webhooks",
    "construct_event",
    "sign_payload",
    "CoinVelloError",
    "ApiError",
    "AuthenticationError",
    "PermissionError",
    "InvalidRequestError",
    "IdempotencyError",
    "RateLimitError",
    "CreditsError",
    "ChainError",
    "PartnerError",
    "ConnectionError",
    "SignatureVerificationError",
]

__version__ = "0.1.0"
