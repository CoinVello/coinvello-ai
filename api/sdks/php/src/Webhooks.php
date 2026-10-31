<?php

declare(strict_types=1);

namespace CoinVello\Sdk;

use CoinVello\Sdk\Exception\SignatureVerificationException;

/**
 * Webhook signature verification.
 *
 * Header:  CoinVello-Signature: t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>]
 * Signed:  "<t>.<raw body>" with HMAC-SHA256 keyed by the endpoint secret (whsec_...).
 */
final class Webhooks
{
    public const DEFAULT_TOLERANCE = 300;

    /**
     * Verify and decode a webhook delivery.
     *
     * @param  string $rawBody  Raw request body (file_get_contents('php://input')), not $_POST.
     * @return array<string,mixed> The event
     * @throws SignatureVerificationException
     */
    public static function constructEvent(string $rawBody, ?string $signatureHeader, string $secret, int $tolerance = self::DEFAULT_TOLERANCE, ?int $now = null): array
    {
        if ($signatureHeader === null || $signatureHeader === '') {
            throw new SignatureVerificationException('Missing CoinVello-Signature header');
        }
        if ($secret === '') {
            throw new SignatureVerificationException('Missing webhook secret');
        }

        $timestamp = 0;
        $signatures = [];
        foreach (explode(',', $signatureHeader) as $pair) {
            $kv = explode('=', trim($pair), 2);
            if (count($kv) !== 2) {
                continue;
            }
            if ($kv[0] === 't') {
                $timestamp = (int) $kv[1];
            } elseif ($kv[0] === 'v1') {
                $signatures[] = $kv[1];
            }
        }
        if ($timestamp <= 0) {
            throw new SignatureVerificationException('Malformed signature header: missing timestamp');
        }
        if ($signatures === []) {
            throw new SignatureVerificationException('Malformed signature header: no v1 signature');
        }
        $now ??= time();
        if (abs($now - $timestamp) > $tolerance) {
            throw new SignatureVerificationException('Timestamp outside the tolerance window');
        }

        $expected = self::computeSignature($rawBody, $secret, $timestamp);
        foreach ($signatures as $sig) {
            if (hash_equals($expected, $sig)) {
                try {
                    $event = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
                } catch (\JsonException $e) {
                    throw new SignatureVerificationException('Payload is not valid JSON');
                }
                if (!is_array($event)) {
                    throw new SignatureVerificationException('Payload is not a JSON object');
                }
                return $event;
            }
        }
        throw new SignatureVerificationException('No signatures found matching the expected signature for payload');
    }

    public static function computeSignature(string $rawBody, string $secret, int $timestamp): string
    {
        return hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
    }

    /** Build a header value (for tests). */
    public static function generateHeader(string $rawBody, string $secret, ?int $timestamp = null): string
    {
        $timestamp ??= time();
        return 't=' . $timestamp . ',v1=' . self::computeSignature($rawBody, $secret, $timestamp);
    }
}
