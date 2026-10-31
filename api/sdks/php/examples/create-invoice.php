<?php

declare(strict_types=1);

/**
 * Create an invoice, simulate a payment (test mode) and verify a webhook signature locally.
 *
 *   COINVELLO_API_KEY=cv_test_x COINVELLO_BASE_URL=http://localhost:4242/v1 php examples/create-invoice.php
 */

require __DIR__ . '/../vendor/autoload.php';

use CoinVello\Sdk\Client;
use CoinVello\Sdk\Exception\ApiErrorException;
use CoinVello\Sdk\Webhooks;

$cv = new Client(getenv('COINVELLO_API_KEY') ?: 'cv_test_example', [
    'base_url' => getenv('COINVELLO_BASE_URL') ?: Client::DEFAULT_BASE_URL,
]);

try {
    $invoice = $cv->invoices()->create([
        'amount' => '49.99',
        'currency' => 'USD',
        'accepted_assets' => ['btc:bitcoin', 'usdc:polygon'],
        'order_id' => 'WC-10042',
        'success_url' => 'https://shop.example.com/thanks',
        'metadata' => ['woocommerce_order_id' => '10042'],
    ], ['idempotency_key' => 'order-10042-invoice']);

    printf("invoice %s %s %s\n", $invoice['id'], $invoice['status'], $invoice['hosted_url']);
    foreach ($invoice['payment_options'] as $po) {
        printf("  pay %s %s -> %s\n", $po['amount'], $po['symbol'], $po['address']);
    }

    if (!$cv->livemode()) {
        $result = $cv->test()->simulatePayment(['invoice_id' => $invoice['id'], 'asset' => 'usdc:polygon', 'confirmations' => 64]);
        printf("after simulation: %s\n", $result['invoice']['status']);
    }

    // Webhook round-trip
    $secret = 'whsec_test_secret';
    $body = json_encode(['id' => 'evt_1', 'object' => 'event', 'type' => 'invoice.paid', 'data' => ['object' => $invoice]]);
    $header = Webhooks::generateHeader($body, $secret);
    $event = $cv->webhooks()->constructEvent($body, $header, $secret);
    printf("verified event %s\n", $event['type']);

    foreach ($cv->invoices()->list(['limit' => 5])->autoPagingIterator() as $inv) {
        printf("listed %s %s\n", $inv['id'], $inv['status']);
    }
} catch (ApiErrorException $e) {
    fprintf(STDERR, "CoinVello %s/%s: %s (request %s)\n", $e->getType(), $e->getErrorCode(), $e->getMessage(), $e->getRequestId());
    exit(1);
}
