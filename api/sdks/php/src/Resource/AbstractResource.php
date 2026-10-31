<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\HttpClient;
use CoinVello\Sdk\ListPage;

abstract class AbstractResource
{
    public function __construct(protected readonly HttpClient $http)
    {
    }

    protected function listPage(string $path, array $params = []): ListPage
    {
        return new ListPage($this->http, $path, $params, $this->http->get($path, $params));
    }
}
