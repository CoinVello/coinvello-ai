<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;

/**
 * The account's book of record: one immutable row per movement of value, valued in the reporting currency
 * at the time it happened. Amounts and values are decimal strings; never cast them to float.
 */
final class Records extends AbstractResource
{
    /**
     * @param array{type?: string, asset?: string, chain?: string, invoice_id?: string, order_id?: string, tx_hash?: string, occurred_gte?: string, occurred_lte?: string, currency?: string, include_simulated?: bool, limit?: int, cursor?: string} $params
     *        `include_simulated` is test mode only: rows from /test/simulate_* appear only when it is true.
     */
    public function list(array $params = []): ListPage { return $this->listPage('/records', self::query($params)); }

    /** @param array{currency?: string} $params  Re-values the record into `currency` at the historical rate. */
    public function retrieve(string $id, array $params = []): array { return $this->http->get('/records/' . rawurlencode($id), $params); }

    /**
     * Sales, market value received, refunds, fees and net received for a period. `period_start` is inclusive and
     * `period_end` exclusive, both read in `timezone` (a date such as 2026-01-01, or a date-time).
     *
     * @param array{period_start: string, period_end: string, currency?: string, timezone?: string, group_by?: string, include_simulated?: bool} $params
     *        `group_by` is one of month, asset, chain, type, address.
     */
    public function summary(array $params): array { return $this->http->get('/records/summary', self::query($params)); }

    /** The query string wants `true`/`false`, not PHP's `1`/`0`. */
    private static function query(array $params): array
    {
        foreach ($params as $k => $v) {
            if (is_bool($v)) {
                $params[$k] = $v ? 'true' : 'false';
            }
        }
        return $params;
    }
}
