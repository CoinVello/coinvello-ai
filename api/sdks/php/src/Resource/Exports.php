<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;

/**
 * Exports of records (or any dataset) as CSV, Excel or JSON. Status: queued, processing, ready, failed, expired.
 */
final class Exports extends AbstractResource
{
    /**
     * Small exports come back `ready`; larger ones are built in the background (poll retrieve()).
     *
     * @param array{dataset?: string, format: string, preset?: string, period?: array{start: string, end: string}|null, timezone?: string, currency?: string, include_simulated?: bool, metadata?: array<string,string>} $body
     *        `period` null or omitted means the entire history; `start` is inclusive, `end` exclusive.
     * @param array{idempotency_key?: string} $opts
     */
    public function create(array $body, array $opts = []): array { return $this->http->post('/exports', $body, $opts); }

    /** @param array{status?: string, dataset?: string, limit?: int, cursor?: string} $params */
    public function list(array $params = []): ListPage { return $this->listPage('/exports', $params); }

    public function retrieve(string $id): array { return $this->http->get('/exports/' . rawurlencode($id)); }

    /** Removes the file before its 7 days are up. The records themselves are untouched. */
    public function delete(string $id): array { return $this->http->delete('/exports/' . rawurlencode($id)); }

    /**
     * The file's bytes. Works whether the API streams the file (200) or redirects to the signed
     * `download_url` (302); the API key is not sent to the signed URL. Throws a 409 ApiErrorException
     * (`export_not_ready`, `export_expired`, `export_failed`) when there is no file to give.
     */
    public function download(string $id): string { return $this->http->download('/exports/' . rawurlencode($id) . '/download'); }
}
