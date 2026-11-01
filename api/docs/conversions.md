# Conversions (non-custodial)

Accept ETH, settle in USDC - without CoinVello ever touching the funds. A conversion is a
swap that CoinVello **prepares** and you **sign**:

```
POST /conversions/quotes   -> quote (route, expected output, fees), valid ~30 s
POST /conversions          -> conversion in awaiting_signature, with unsigned_transactions
   (you sign with your wallet)
POST /conversions/{id}/submit -> CoinVello broadcasts (or you pass tx_hash after broadcasting)
   -> submitted -> pending -> completed   (webhook conversion.completed)
```

CoinVello sources liquidity from DEX aggregators (same-chain) and, optionally, from partner
exchange accounts you connected yourself (see [offramp.md](offramp.md)). In every route the
transaction that moves your funds is signed by your key; CoinVello only builds the calldata.

## Quote

```bash
curl https://api.coinvello.com/v1/conversions/quotes \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{
    "from_asset": "eth:ethereum",
    "to_asset": "usdc:ethereum",
    "amount": "0.5",
    "from_wallet_id": "wal_evm_4Fg7Kp",
    "slippage_bps": 50
  }'
```

```json
{
  "id": "cq_8Hj3Kl5Mn",
  "from_amount": "0.5",
  "to_amount": "1253.38",
  "to_amount_min": "1247.11",
  "rate": "2506.76",
  "route": { "type": "dex", "provider": "1inch", "steps": [ ... ] },
  "estimated_network_fee": { "amount": "0.0012", "currency": "eth:ethereum" },
  "credits_required": 5,
  "requires_approval": false,
  "expires_at": "2026-10-21T10:00:30Z"
}
```

`from_wallet_id` must be an **address** wallet (EVM/Solana/Tron) - UTXO wallets registered by
xpub cannot be used as a swap source because CoinVello has no view of which UTXOs are
spendable by which key; for BTC->stable conversions use a partner route via a connected
exchange account (`route_preference: partner_only`).

`requires_approval: true` means an ERC-20 `approve` must be signed first; it becomes step 1
in `unsigned_transactions`.

## Create and sign

```bash
curl https://api.coinvello.com/v1/conversions \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: conv-2026-10-21-01" \
  -d '{ "quote_id": "cq_8Hj3Kl5Mn" }'
```

Response `status: awaiting_signature`, `credits_charged: 126` (10 bps nominal of the $1,253 swapped, see [credits.md](credits.md)), and:

```json
"unsigned_transactions": [
  {
    "step": 1,
    "purpose": "swap",
    "chain": "ethereum",
    "format": "eip1559",
    "from": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "payload": {
      "chainId": "0x1", "from": "0x8ba1...", "to": "0x1111111254...", "value": "0x6f05b59d3b20000",
      "data": "0x12aa3caf...", "nonce": "0x2a", "gas": "0x3d090",
      "maxFeePerGas": "0x3b9aca00", "maxPriorityFeePerGas": "0x3b9aca00"
    },
    "human_readable": { "summary": "Swap 0.5 ETH for at least 1,247.11 USDC via 1inch", "to_label": "1inch Aggregation Router v6" },
    "expires_at": "2026-10-21T10:10:00Z"
  }
]
```

Sign with whatever holds the key:

```ts
// viem / MetaMask (browser dashboard does this for you)
const hash = await walletClient.sendTransaction({
  to: tx.payload.to, value: BigInt(tx.payload.value), data: tx.payload.data,
  nonce: Number(tx.payload.nonce), gas: BigInt(tx.payload.gas),
  maxFeePerGas: BigInt(tx.payload.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.payload.maxPriorityFeePerGas),
});
await coinvello.conversions.submit(conv.id, { tx_hashes: [{ step: 1, tx_hash: hash }] });
```

Or sign offline and let CoinVello broadcast:

```bash
curl https://api.coinvello.com/v1/conversions/cnv_2Lk9Mn4Pq/submit \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{ "signed_transactions": [ { "step": 1, "signed": "0x02f8b1018203e8..." } ] }'
```

CoinVello checks the signed transaction decodes to **exactly** the unsigned one it prepared
(`to`, `data`, `value`, chain) before broadcasting - a tampered or mismatched tx is rejected
with `422 transaction_mismatch`.

Formats by chain: `eip1559` (EVM), `psbt_base64` (BTC, partner deposits), `solana_message_base64`,
`tron_raw_hex`. Each `payload` is documented in the `UnsignedTransaction` schema.

## Status

| Status | Meaning |
|--------|---------|
| `awaiting_signature` | Sign before `signature_deadline` (typically 10 minutes; quotes and nonces go stale) |
| `submitted` | Broadcast, not yet mined |
| `pending` | Mined, waiting for confirmations |
| `completed` | Done; `to_amount_received` set; `conversion.completed` fired |
| `failed` | Reverted / dropped; `failure_reason` set; credits refunded; `conversion.failed` fired |
| `expired` | Not signed before the deadline; credits refunded |
| `cancelled` | You cancelled while awaiting signature; credits refunded |

`POST /conversions/{id}/cancel` only works in `awaiting_signature` - nothing can be cancelled
once a transaction is on-chain.

## Auto-convert on payment

In the dashboard you can set a per-wallet rule "when an invoice is paid in X, quote a
conversion to Y". CoinVello then creates the conversion and emits it in `awaiting_signature`;
with a connected browser wallet session or a signing webhook (your server signs and calls
`/submit`), this becomes hands-off while remaining non-custodial. The rule never auto-signs:
signing always happens with your key, on your side.

## Fees

10 bps nominal of the swapped amount in credits (1 credit = $0.01; cap 1,000 credits per swap, refunded if the conversion fails or expires) plus the on-chain network fee you pay directly and the aggregator /
partner spread shown in the quote. CoinVello adds no hidden spread.
