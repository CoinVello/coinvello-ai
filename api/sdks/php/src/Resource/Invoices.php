<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;

final class Invoices extends AbstractResource
{
    /**
     * `$params['tax']` is optional: `['amount' => '7.98', 'rate' => '0.19', 'label' => 'VAT 19%', 'jurisdiction' => 'DE']`.
     * `amount` is a decimal string in the invoice currency and is already included in the invoice amount;
     * `rate`, `label` and `jurisdiction` are optional. It is kept on the invoice and its records for exports.
     *
     * @param array{amount?: string, currency?: string, tax?: array{amount: string, rate?: ?string, label?: ?string, jurisdiction?: ?string}} $params  (plus the other fields of the Invoice create request)
     * @param array{idempotency_key?: string} $opts
     */
    public function create(array $params, array $opts = []): array { return $this->http->post('/invoices', $params, $opts); }
    public function get(string $id): array { return $this->http->get("/invoices/{$id}"); }
    public function list(array $params = []): ListPage { return $this->listPage('/invoices', $params); }
    public function update(string $id, array $params): array { return $this->http->patch("/invoices/{$id}", $params); }
    public function cancel(string $id, array $opts = []): array { return $this->http->post("/invoices/{$id}/cancel", [], $opts); }
    public function expire(string $id, array $opts = []): array { return $this->http->post("/invoices/{$id}/expire", [], $opts); }
    public function listPayments(string $id, array $params = []): ListPage { return $this->listPage("/invoices/{$id}/payments", $params); }
}
