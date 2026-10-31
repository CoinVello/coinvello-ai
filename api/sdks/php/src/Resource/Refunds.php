<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;

final class Refunds extends AbstractResource
{
    public function create(array $params, array $opts = []): array { return $this->http->post('/refunds', $params, $opts); }
    public function get(string $id): array { return $this->http->get("/refunds/{$id}"); }
    public function list(array $params = []): ListPage { return $this->listPage('/refunds', $params); }
    public function submit(string $id, array $submission): array { return $this->http->post("/refunds/{$id}/submit", $submission); }
    public function cancel(string $id): array { return $this->http->post("/refunds/{$id}/cancel"); }
}
