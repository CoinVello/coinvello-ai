<?php

declare(strict_types=1);

namespace CoinVello\Sdk\Resource;

use CoinVello\Sdk\ListPage;

final class Wallets extends AbstractResource
{
    public function create(array $params, array $opts = []): array { return $this->http->post('/wallets', $params, $opts); }
    public function get(string $id): array { return $this->http->get("/wallets/{$id}"); }
    public function list(array $params = []): ListPage { return $this->listPage('/wallets', $params); }
    public function update(string $id, array $params): array { return $this->http->patch("/wallets/{$id}", $params); }
    public function archive(string $id): array { return $this->http->delete("/wallets/{$id}"); }
    public function createVerification(string $id): array { return $this->http->post("/wallets/{$id}/verification"); }
    public function verify(string $id, string $signature, ?string $challengeId = null): array
    {
        return $this->http->post("/wallets/{$id}/verify", array_filter(['signature' => $signature, 'challenge_id' => $challengeId]));
    }
    public function listAddresses(string $id, array $params = []): ListPage { return $this->listPage("/wallets/{$id}/addresses", $params); }
}
