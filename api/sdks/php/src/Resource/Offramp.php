<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;

final class Offramp extends AbstractResource
{
    public function providers(): array { return $this->http->get('/offramp/providers'); }
    public function connectAccount(array $params, array $opts = []): array { return $this->http->post('/offramp/accounts', $params, $opts); }
    public function getAccount(string $id): array { return $this->http->get("/offramp/accounts/{$id}"); }
    public function listAccounts(array $params = []): ListPage { return $this->listPage('/offramp/accounts', $params); }
    public function disconnectAccount(string $id): array { return $this->http->delete("/offramp/accounts/{$id}"); }
    public function quote(array $params): array { return $this->http->post('/offramp/quotes', $params); }
    public function createPayout(array $params, array $opts = []): array { return $this->http->post('/offramp/payouts', $params, $opts); }
    public function getPayout(string $id): array { return $this->http->get("/offramp/payouts/{$id}"); }
    public function listPayouts(array $params = []): ListPage { return $this->listPage('/offramp/payouts', $params); }
    public function submitPayout(string $id, array $submission): array { return $this->http->post("/offramp/payouts/{$id}/submit", $submission); }
    public function cancelPayout(string $id): array { return $this->http->post("/offramp/payouts/{$id}/cancel"); }
}
