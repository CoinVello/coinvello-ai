<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Exception;

/**
 * Error returned by the API. Subclasses map the error envelope `type`:
 * AuthenticationException, PermissionException, InvalidRequestException, IdempotencyException,
 * RateLimitException, CreditsException, ChainException, PartnerException, ApiException.
 */
class ApiErrorException extends CoinVelloException
{
    /** @param array<string,mixed> $error */
    public function __construct(
        private readonly array $error,
        private readonly int $httpStatus,
        private readonly ?int $retryAfter = null,
    ) {
        parent::__construct((string) ($error['message'] ?? 'Unknown error'), $httpStatus);
    }

    /** @param array<string,mixed>|null $body */
    public static function fromResponse(int $status, ?array $body, ?int $retryAfter = null): self
    {
        $error = $body['error'] ?? ['type' => 'api_error', 'code' => 'unknown', 'message' => "HTTP {$status}", 'request_id' => ''];
        $class = match ($error['type'] ?? '') {
            'authentication_error' => AuthenticationException::class,
            'permission_error' => PermissionException::class,
            'invalid_request_error' => InvalidRequestException::class,
            'idempotency_error' => IdempotencyException::class,
            'rate_limit_error' => RateLimitException::class,
            'credits_error' => CreditsException::class,
            'chain_error' => ChainException::class,
            'partner_error' => PartnerException::class,
            default => ApiException::class,
        };
        return new $class($error, $status, $retryAfter);
    }

    public function getType(): string { return (string) ($this->error['type'] ?? ''); }
    public function getErrorCode(): string { return (string) ($this->error['code'] ?? ''); }
    public function getParam(): ?string { return $this->error['param'] ?? null; }
    public function getRequestId(): ?string { return $this->error['request_id'] ?? null; }
    public function getHttpStatus(): int { return $this->httpStatus; }
    public function getRetryAfter(): ?int { return $this->retryAfter; }
    /** @return array<string,mixed> */
    public function getDetails(): array { return $this->error['details'] ?? []; }
    /** @return array<string,mixed> */
    public function getError(): array { return $this->error; }
}
