<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

final class Test extends AbstractResource
{
    /**
     * Test mode only. Simulates an on-chain payment for an invoice (inv_) or credit purchase (cpu_).
     * @param array{invoice_id: string, asset?: string, amount?: string, confirmations?: int, tx_hash?: string} $params
     * @return array{payment: array<string,mixed>, invoice: array<string,mixed>}
     */
    public function simulatePayment(array $params, array $opts = []): array
    {
        return $this->http->post('/test/simulate_payment', $params, $opts);
    }
}
