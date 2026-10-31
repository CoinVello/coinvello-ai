export interface ErrorBody {
  error: {
    type: string;
    code: string;
    message: string;
    param?: string;
    request_id: string;
    doc_url?: string;
    details?: Record<string, unknown>;
  };
}

export class CoinVelloError extends Error {
  readonly type: string;
  readonly code: string;
  readonly param?: string;
  readonly requestId?: string;
  readonly httpStatus?: number;
  readonly details?: Record<string, unknown>;
  readonly retryAfter?: number;

  constructor(body: ErrorBody["error"], httpStatus?: number, retryAfter?: number) {
    super(body.message);
    this.name = new.target.name;
    this.type = body.type;
    this.code = body.code;
    this.param = body.param;
    this.requestId = body.request_id;
    this.httpStatus = httpStatus;
    this.details = body.details;
    this.retryAfter = retryAfter;
  }

  static fromResponse(status: number, body: unknown, retryAfterHeader?: string | null): CoinVelloError {
    const err = (body as ErrorBody | undefined)?.error ?? {
      type: "api_error",
      code: "unknown",
      message: `HTTP ${status}`,
      request_id: "",
    };
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;
    const ctor = ERROR_CLASSES[err.type] ?? ApiError;
    return new ctor(err, status, retryAfter);
  }
}

export class AuthenticationError extends CoinVelloError {}
export class PermissionError extends CoinVelloError {}
export class InvalidRequestError extends CoinVelloError {}
export class IdempotencyError extends CoinVelloError {}
export class RateLimitError extends CoinVelloError {}
export class CreditsError extends CoinVelloError {}
export class ChainError extends CoinVelloError {}
export class PartnerError extends CoinVelloError {}
export class ApiError extends CoinVelloError {}

export class ConnectionError extends CoinVelloError {
  constructor(message: string, cause?: unknown) {
    super({ type: "connection_error", code: "connection_failed", message, request_id: "" });
    (this as { cause?: unknown }).cause = cause;
  }
}

export class SignatureVerificationError extends CoinVelloError {
  constructor(message: string) {
    super({ type: "signature_verification_error", code: "signature_invalid", message, request_id: "" });
  }
}

const ERROR_CLASSES: Record<string, new (b: ErrorBody["error"], s?: number, r?: number) => CoinVelloError> = {
  authentication_error: AuthenticationError,
  permission_error: PermissionError,
  invalid_request_error: InvalidRequestError,
  idempotency_error: IdempotencyError,
  rate_limit_error: RateLimitError,
  credits_error: CreditsError,
  chain_error: ChainError,
  partner_error: PartnerError,
  api_error: ApiError,
};
