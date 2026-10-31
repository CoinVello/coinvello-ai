<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;
use CoinVello\Sdk\Webhooks;

final class WebhookEndpoints extends AbstractResource
{
    public function create(array $params, array $opts = []): array { return $this->http->post('/webhooks', $params, $opts); }
    public function get(string $id): array { return $this->http->get("/webhooks/{$id}"); }
    public function list(array $params = []): ListPage { return $this->listPage('/webhooks', $params); }
    public function update(string $id, array $params): array { return $this->http->patch("/webhooks/{$id}", $params); }
    public function delete(string $id): array { return $this->http->delete("/webhooks/{$id}"); }
    public function rotateSecret(string $id, ?int $gracePeriodSeconds = null): array
    {
        return $this->http->post("/webhooks/{$id}/rotate_secret", array_filter(['grace_period_seconds' => $gracePeriodSeconds]));
    }
    public function test(string $id, string $eventType = 'ping'): array { return $this->http->post("/webhooks/{$id}/test", ['event_type' => $eventType]); }
    public function listDeliveries(string $id, array $params = []): ListPage { return $this->listPage("/webhooks/{$id}/deliveries", $params); }
    public function retryDelivery(string $id, string $deliveryId): array { return $this->http->post("/webhooks/{$id}/deliveries/{$deliveryId}/retry"); }

    /**
     * Verify a signed delivery and return the decoded event.
     * @throws \CoinVello\Sdk\Exception\SignatureVerificationException
     */
    public function constructEvent(string $rawBody, ?string $signatureHeader, string $secret, int $tolerance = Webhooks::DEFAULT_TOLERANCE): array
    {
        return Webhooks::constructEvent($rawBody, $signatureHeader, $secret, $tolerance);
    }
}
