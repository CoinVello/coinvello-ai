<?php

declare(strict_types=1);

namespace CoinVello\Sdk;

use CoinVello\Sdk\Exception\ApiErrorException;
use CoinVello\Sdk\Exception\ConnectionException;

/**
 * Tiny curl-based transport with retries and idempotency keys. No Guzzle dependency, so the
 * WooCommerce plugin can vendor this without conflicts.
 */
final class HttpClient
{
    private string $apiKey;
    private string $baseUrl;
    private string $apiVersion;
    private int $timeout;
    private int $maxRetries;
    private string $userAgent;

    /** @param array{base_url?: string, api_version?: string, timeout?: int, max_retries?: int, user_agent?: string} $options */
    public function __construct(string $apiKey, array $options = [])
    {
        if (!preg_match('/^cv_(live|test)_/', $apiKey)) {
            throw new \InvalidArgumentException('CoinVello API key must start with cv_live_ or cv_test_');
        }
        $this->apiKey = $apiKey;
        $this->baseUrl = rtrim($options['base_url'] ?? Client::DEFAULT_BASE_URL, '/');
        $this->apiVersion = $options['api_version'] ?? Client::DEFAULT_API_VERSION;
        $this->timeout = $options['timeout'] ?? 30;
        $this->maxRetries = $options['max_retries'] ?? 3;
        $this->userAgent = $options['user_agent'] ?? sprintf('coinvello-php/%s (php %s)', Client::VERSION, PHP_VERSION);
    }

    public function livemode(): bool
    {
        return str_starts_with($this->apiKey, 'cv_live_');
    }

    /** @return array<string,mixed> */
    public function get(string $path, array $query = []): array
    {
        return $this->request('GET', $path, null, [], $query);
    }

    /** @param array{idempotency_key?: string} $opts  @return array<string,mixed> */
    public function post(string $path, array $body = [], array $opts = []): array
    {
        return $this->request('POST', $path, $body, $opts);
    }

    /** @return array<string,mixed> */
    public function patch(string $path, array $body): array
    {
        return $this->request('PATCH', $path, $body);
    }

    /** @return array<string,mixed> */
    public function put(string $path, array $body): array
    {
        return $this->request('PUT', $path, $body);
    }

    /** @return array<string,mixed> */
    public function delete(string $path): array
    {
        return $this->request('DELETE', $path);
    }

    /** @return array<string,mixed> */
    public function request(string $method, string $path, ?array $body = null, array $opts = [], array $query = []): array
    {
        $url = $this->baseUrl . $path;
        $query = array_filter($query, static fn ($v) => $v !== null);
        if ($query !== []) {
            $url .= '?' . http_build_query($query);
        }

        $headers = [
            'Authorization: Bearer ' . $this->apiKey,
            'Accept: application/json',
            'User-Agent: ' . $this->userAgent,
            'CoinVello-Version: ' . ($opts['api_version'] ?? $this->apiVersion),
        ];
        $payload = null;
        if ($body !== null) {
            $payload = json_encode($body === [] ? new \stdClass() : $body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
            $headers[] = 'Content-Type: application/json';
        }
        if ($method === 'POST') {
            $headers[] = 'Idempotency-Key: ' . ($opts['idempotency_key'] ?? self::uuid4());
        }

        $attempt = 0;
        while (true) {
            $attempt++;
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_CUSTOMREQUEST => $method,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HEADER => true,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_TIMEOUT => $opts['timeout'] ?? $this->timeout,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
            ]);
            if ($payload !== null) {
                curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
            }
            $raw = curl_exec($ch);
            if ($raw === false) {
                $err = curl_error($ch);
                curl_close($ch);
                if ($attempt <= $this->maxRetries) {
                    usleep($this->backoffMicros($attempt));
                    continue;
                }
                throw new ConnectionException("Request to {$path} failed: {$err}");
            }
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
            curl_close($ch);

            $rawHeaders = substr($raw, 0, $headerSize);
            $bodyText = substr($raw, $headerSize);
            $retryAfter = $this->headerValue($rawHeaders, 'Retry-After');

            if ($status === 204) {
                return [];
            }
            $json = json_decode($bodyText, true);
            if (!is_array($json)) {
                $json = ['error' => ['type' => 'api_error', 'code' => 'invalid_json', 'message' => substr($bodyText, 0, 200), 'request_id' => '']];
            }
            if ($status >= 200 && $status < 300) {
                return $json;
            }

            $exception = ApiErrorException::fromResponse($status, $json, $retryAfter !== null ? (int) $retryAfter : null);
            $retryable = $status >= 500 || $status === 429 || ($status === 409 && $exception->getErrorCode() === 'idempotency_key_in_progress');
            if ($retryable && $attempt <= $this->maxRetries) {
                usleep($retryAfter !== null ? ((int) $retryAfter) * 1_000_000 : $this->backoffMicros($attempt));
                continue;
            }
            throw $exception;
        }
    }

    /**
     * GET a non-JSON body and return its raw bytes (export files). The redirect is not followed with the
     * API key: a 3xx `Location` (the signed `download_url`) is fetched in a second request that carries
     * no Authorization header. API errors (e.g. 409 export_not_ready) throw like any other call.
     *
     * @param array{timeout?: int} $opts
     */
    public function download(string $path, array $query = [], array $opts = []): string
    {
        $url = $this->baseUrl . $path;
        $query = array_filter($query, static fn ($v) => $v !== null);
        if ($query !== []) {
            $url .= '?' . http_build_query($query);
        }
        $timeout = $opts['timeout'] ?? $this->timeout;
        $ua = 'User-Agent: ' . $this->userAgent;

        $res = $this->fetchRaw($url, [
            'Authorization: Bearer ' . $this->apiKey,
            'Accept: */*',
            $ua,
            'CoinVello-Version: ' . ($opts['api_version'] ?? $this->apiVersion),
        ], $timeout, false);

        if ($res['status'] >= 400) {
            $json = json_decode($res['body'], true);
            if (!is_array($json)) {
                $json = ['error' => ['type' => 'api_error', 'code' => 'invalid_json', 'message' => substr($res['body'], 0, 200), 'request_id' => '']];
            }
            $retryAfter = $this->headerValue($res['headers'], 'Retry-After');
            throw ApiErrorException::fromResponse($res['status'], $json, $retryAfter !== null ? (int) $retryAfter : null);
        }
        if ($res['status'] >= 300) {
            $location = $this->headerValue($res['headers'], 'Location');
            if ($location === null || $location === '') {
                throw new ConnectionException("Download of {$path} redirected without a Location");
            }
            $res = $this->fetchRaw($this->resolveLocation($location), ['Accept: */*', $ua], $timeout, true);
            if ($res['status'] < 200 || $res['status'] >= 300) {
                throw new ConnectionException("Download of {$path} failed at the signed URL (HTTP {$res['status']})");
            }
        }
        return $res['body'];
    }

    /**
     * One GET with the same retry policy as request() (connection errors, 429, 5xx). Returns the final
     * response whatever its status; the caller decides what an error status means.
     *
     * @param array<int,string> $headers
     * @return array{status: int, headers: string, body: string}
     */
    private function fetchRaw(string $url, array $headers, int $timeout, bool $follow): array
    {
        $attempt = 0;
        while (true) {
            $attempt++;
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_HEADER => true,
                CURLOPT_HTTPHEADER => $headers,
                CURLOPT_TIMEOUT => $timeout,
                CURLOPT_CONNECTTIMEOUT => 10,
                CURLOPT_FOLLOWLOCATION => $follow,
                CURLOPT_MAXREDIRS => 5,
                CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
                CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
                CURLOPT_SSL_VERIFYPEER => true,
                CURLOPT_SSL_VERIFYHOST => 2,
            ]);
            $raw = curl_exec($ch);
            if ($raw === false) {
                $err = curl_error($ch);
                curl_close($ch);
                if ($attempt <= $this->maxRetries) {
                    usleep($this->backoffMicros($attempt));
                    continue;
                }
                throw new ConnectionException("Download request failed: {$err}");
            }
            $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
            curl_close($ch);

            $rawHeaders = substr($raw, 0, $headerSize);
            $bodyText = (string) substr($raw, $headerSize);
            if (($status >= 500 || $status === 429) && $attempt <= $this->maxRetries) {
                $retryAfter = $this->headerValue($rawHeaders, 'Retry-After');
                usleep($retryAfter !== null ? ((int) $retryAfter) * 1_000_000 : $this->backoffMicros($attempt));
                continue;
            }
            return ['status' => $status, 'headers' => $rawHeaders, 'body' => $bodyText];
        }
    }

    /** Absolute URL for a Location header; a path is resolved against the API base URL's origin. */
    private function resolveLocation(string $location): string
    {
        if (preg_match('#^https?://#i', $location)) {
            return $location;
        }
        $base = parse_url($this->baseUrl);
        $origin = ($base['scheme'] ?? 'https') . '://' . ($base['host'] ?? '') . (isset($base['port']) ? ':' . $base['port'] : '');
        return $origin . '/' . ltrim($location, '/');
    }

    private function headerValue(string $rawHeaders, string $name): ?string
    {
        if (preg_match('/^' . preg_quote($name, '/') . ':\s*(.+)$/mi', $rawHeaders, $m)) {
            return trim($m[1]);
        }
        return null;
    }

    private function backoffMicros(int $attempt): int
    {
        $base = min(500_000 * (2 ** ($attempt - 1)), 8_000_000);
        return (int) ($base / 2 + random_int(0, (int) ($base / 2)));
    }

    public static function uuid4(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }
}
