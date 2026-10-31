<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;

final class Payments extends AbstractResource
{
    public function get(string $id): array { return $this->http->get("/payments/{$id}"); }
    public function list(array $params = []): ListPage { return $this->listPage('/payments', $params); }
}
