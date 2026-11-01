<?php

declare(strict_types=1);

namespace CoinVello\Sdk;

use CoinVello\Sdk\Resource\CheckoutSessions;
use CoinVello\Sdk\Resource\Conversions;
use CoinVello\Sdk\Resource\Credits;
use CoinVello\Sdk\Resource\Events;
use CoinVello\Sdk\Resource\Exports;
use CoinVello\Sdk\Resource\Invoices;
use CoinVello\Sdk\Resource\Offramp;
use CoinVello\Sdk\Resource\Payments;
use CoinVello\Sdk\Resource\Rates;
use CoinVello\Sdk\Resource\Records;
use CoinVello\Sdk\Resource\Refunds;
use CoinVello\Sdk\Resource\Test;
use CoinVello\Sdk\Resource\Wallets;
use CoinVello\Sdk\Resource\WebhookEndpoints;

/**
 * CoinVello API client.
 *
 *   $cv = new \CoinVello\Sdk\Client(getenv('COINVELLO_API_KEY'));
 *   $invoice = $cv->invoices()->create(['amount' => '49.99', 'currency' => 'USD']);
 *   $event = $cv->webhooks()->constructEvent($rawBody, $signatureHeader, $secret);
 */
final class Client
{
    public const VERSION = '0.1.1';
    public const DEFAULT_BASE_URL = 'https://api.coinvello.com/v1';
    public const DEFAULT_API_VERSION = '2026-10-01';

    private HttpClient $http;

    /**
     * @param array{base_url?: string, api_version?: string, timeout?: int, max_retries?: int, user_agent?: string} $options
     */
    public function __construct(string $apiKey, array $options = [])
    {
        $this->http = new HttpClient($apiKey, $options);
    }

    public function livemode(): bool
    {
        return $this->http->livemode();
    }

    public function http(): HttpClient
    {
        return $this->http;
    }

    public function invoices(): Invoices { return new Invoices($this->http); }
    public function payments(): Payments { return new Payments($this->http); }
    public function wallets(): Wallets { return new Wallets($this->http); }
    public function webhooks(): WebhookEndpoints { return new WebhookEndpoints($this->http); }
    public function credits(): Credits { return new Credits($this->http); }
    public function rates(): Rates { return new Rates($this->http); }
    public function conversions(): Conversions { return new Conversions($this->http); }
    public function offramp(): Offramp { return new Offramp($this->http); }
    public function checkoutSessions(): CheckoutSessions { return new CheckoutSessions($this->http); }
    public function refunds(): Refunds { return new Refunds($this->http); }
    public function events(): Events { return new Events($this->http); }
    public function records(): Records { return new Records($this->http); }
    public function exports(): Exports { return new Exports($this->http); }
    public function test(): Test { return new Test($this->http); }
}
