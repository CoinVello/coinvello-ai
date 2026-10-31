<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;

final class Credits extends AbstractResource
{
    /**
     * `balance` (= `available` + `reserved`, never negative), `available` (free to spend) and `reserved`
     * (estimated fees of open invoices paid with credits), plus `low_balance_threshold`,
     * `estimated_payments_remaining`, `expiring_soon` and `auto_topup`.
     *
     * @return array<string, mixed>
     */
    public function balance(): array { return $this->http->get('/credits/balance'); }
    /** @return array{object: string, data: array<int,array<string,mixed>>} */
    public function bundles(): array { return $this->http->get('/credits/bundles'); }
    /** @param array{bundle_id: string, pay_asset?: string, pay_chain?: string, expires_in?: int, metadata?: array} $params */
    public function purchase(array $params, array $opts = []): array { return $this->http->post('/credits/purchases', $params, $opts); }
    public function getPurchase(string $id): array { return $this->http->get("/credits/purchases/{$id}"); }
    public function listPurchases(array $params = []): ListPage { return $this->listPage('/credits/purchases', $params); }
    public function cancelPurchase(string $id): array { return $this->http->post("/credits/purchases/{$id}/cancel"); }
    public function ledger(array $params = []): ListPage { return $this->listPage('/credits/ledger', $params); }
    public function setAutoTopup(array $params): array { return $this->http->put('/credits/auto_topup', $params); }
}
