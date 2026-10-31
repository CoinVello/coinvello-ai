<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;

final class CheckoutSessions extends AbstractResource
{
    /**
     * Accepts the same optional `tax` as Invoices::create(): `['amount' => '7.98', 'rate' => '0.19', 'label' => 'VAT 19%', 'jurisdiction' => 'DE']`.
     * @param array{idempotency_key?: string} $opts
     */
    public function create(array $params, array $opts = []): array { return $this->http->post('/checkout-sessions', $params, $opts); }
    public function get(string $id, bool $expandInvoice = false): array
    {
        return $this->http->get("/checkout-sessions/{$id}", $expandInvoice ? ['expand' => 'invoice'] : []);
    }
    public function list(array $params = []): ListPage { return $this->listPage('/checkout-sessions', $params); }
    public function expire(string $id): array { return $this->http->post("/checkout-sessions/{$id}/expire"); }
    /** Public, unauthenticated payer view (no API key sent). */
    public static function fetchPublic(string $id, string $baseUrl = \CoinVello\Sdk\Client::DEFAULT_BASE_URL): array
    {
        $ch = curl_init(rtrim($baseUrl, '/') . '/checkout-sessions/' . rawurlencode($id) . '/public');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => ['Accept: application/json'], CURLOPT_TIMEOUT => 15]);
        $raw = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($raw === false || $status >= 400) {
            throw new \CoinVello\Sdk\Exception\ConnectionException("Public session fetch failed ({$status})");
        }
        return json_decode((string) $raw, true, 512, JSON_THROW_ON_ERROR);
    }
    public static function eventsUrl(string $id, string $baseUrl = \CoinVello\Sdk\Client::DEFAULT_BASE_URL): string
    {
        return rtrim($baseUrl, '/') . '/checkout-sessions/' . rawurlencode($id) . '/events';
    }
}
