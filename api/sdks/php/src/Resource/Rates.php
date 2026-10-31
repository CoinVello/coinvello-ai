<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

final class Rates extends AbstractResource
{
    /** @param string[] $assets */
    public function list(string $base = 'USD', array $assets = []): array
    {
        return $this->http->get('/rates', ['base' => $base, 'assets' => $assets ? implode(',', $assets) : null]);
    }
    public function quote(array $params): array { return $this->http->post('/rates/quotes', $params); }
    public function lock(string $quoteId, ?int $durationSeconds = null, array $opts = []): array
    {
        return $this->http->post('/rates/locks', array_filter(['quote_id' => $quoteId, 'duration_seconds' => $durationSeconds]), $opts);
    }
    public function getLock(string $id): array { return $this->http->get("/rates/locks/{$id}"); }
}
