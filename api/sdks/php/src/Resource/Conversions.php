<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;

final class Conversions extends AbstractResource
{
    public function quote(array $params): array { return $this->http->post('/conversions/quotes', $params); }
    public function create(string $quoteId, array $metadata = [], array $opts = []): array
    {
        return $this->http->post('/conversions', array_filter(['quote_id' => $quoteId, 'metadata' => $metadata ?: null]), $opts);
    }
    public function get(string $id): array { return $this->http->get("/conversions/{$id}"); }
    public function list(array $params = []): ListPage { return $this->listPage('/conversions', $params); }
    /** @param array{signed_transactions?: array, tx_hashes?: array} $submission */
    public function submit(string $id, array $submission): array { return $this->http->post("/conversions/{$id}/submit", $submission); }
    public function cancel(string $id): array { return $this->http->post("/conversions/{$id}/cancel"); }
}
