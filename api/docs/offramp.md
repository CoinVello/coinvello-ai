# Off-ramp (fiat payouts via your own partner account)

CoinVello never touches fiat. The off-ramp flow lets you turn crypto you received into money
in your bank account by orchestrating a **partner you connect yourself** - an exchange or
payout provider where *you* hold the account and *you* registered the bank account.

```
POST /offramp/accounts  -> connect partner (OAuth redirect or your API key)
POST /offramp/quotes    -> partner quote for asset -> fiat
POST /offramp/payouts   -> payout in awaiting_deposit, with unsigned_transaction to the partner's deposit address
   (you sign with your wallet)
POST /offramp/payouts/{id}/submit
   -> deposit_pending -> deposit_confirmed -> converting -> payout_initiated -> completed
   (webhook offramp.completed)
```

## Verification happens at the partner, not at CoinVello

CoinVello itself has no KYC/KYB. Regulated partners do: when you connect an exchange or
payout provider, **that partner** will have verified you (or will ask you to) under their own
terms, on their own site. CoinVello never sees, stores or requests identity documents; it
only holds the OAuth token or API key you grant it, encrypted, and uses it to request quotes
and create withdrawals to bank destinations that already exist at the partner.

If a partner requires additional verification before a payout, the API surfaces
`partner_error / partner_verification_required` with a link into the partner's own flow.

## Providers

```bash
curl https://api.coinvello.com/v1/offramp/providers
```

Returns each partner's `connection_modes` (`oauth`, `api_key`), supported assets, fiat
currencies, regions and typical settlement time. The initial set targets major exchanges with
public APIs and OAuth (e.g. Kraken, Coinbase, Bitstamp, Bitvavo) plus payout-API providers;
check the live list.

## Connect an account

### OAuth

```bash
curl https://api.coinvello.com/v1/offramp/accounts \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{ "provider": "coinbase", "connection_mode": "oauth", "label": "Coinbase business", "redirect_url": "https://coinvello.com/app/offramp/connected" }'
```

Response `status: pending_authorization` with `authorize_url`. Send the merchant there; after
consent the account becomes `active` and lists its `destinations` (bank accounts already
set up at the partner, masked).

### API key

```bash
curl https://api.coinvello.com/v1/offramp/accounts \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{ "provider": "kraken", "connection_mode": "api_key", "label": "Kraken", "credentials": { "api_key": "...", "api_secret": "..." } }'
```

Grant the partner key only **trade** and **withdraw to pre-approved bank destinations**.
Never grant crypto withdrawal. Credentials are write-only, encrypted with a per-merchant KMS
key, and never returned by the API.

`DELETE /offramp/accounts/{id}` disconnects and wipes the credentials.

## Quote

```bash
curl https://api.coinvello.com/v1/offramp/quotes \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{ "account_id": "ofa_5Gh7Jk9Lm", "asset": "usdc:ethereum", "amount": "1250.00", "fiat_currency": "EUR" }'
```

```json
{
  "id": "oq_8Jk2Lm6Np",
  "fiat_amount_gross": "1149.50",
  "partner_fee": { "amount": "3.30", "currency": "EUR" },
  "fiat_amount_net": "1146.20",
  "rate": "0.9196",
  "destination_id": "dest_eur_1",
  "credits_required": 10,
  "expires_at": "2026-10-21T10:01:00Z"
}
```

## Create the payout and sign the deposit

```bash
curl https://api.coinvello.com/v1/offramp/payouts \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: payout-2026-10-21-1" \
  -d '{ "quote_id": "oq_8Jk2Lm6Np", "from_wallet_id": "wal_evm_4Fg7Kp" }'
```

The payout is `awaiting_deposit`. CoinVello asked the partner for a deposit address for your
account and built `unsigned_transaction` (ERC-20 transfer of 1250 USDC from your wallet to
`deposit_address`). Sign it exactly as in [conversions.md](conversions.md) and submit:

```bash
curl https://api.coinvello.com/v1/offramp/payouts/ofp_3Mn7Pq1Rs/submit \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{ "tx_hashes": [ { "step": 1, "tx_hash": "0xabc123..." } ] }'
```

CoinVello then watches the deposit, instructs the partner to sell and withdraw to the chosen
destination, and tracks the partner's status until the fiat is sent.

For BTC sources, `unsigned_transaction.format` is `psbt_base64`; sign in Sparrow /
Electrum / hardware wallet and submit the finalized PSBT or the broadcast tx hash.

## Status

| Status | Meaning |
|--------|---------|
| `awaiting_deposit` | Sign and send before `deposit_deadline` (typically 30 min, partner-dependent) |
| `deposit_pending` | Deposit tx seen, confirming |
| `deposit_confirmed` | Partner credited the deposit |
| `converting` | Partner selling to fiat at (or near) the quoted rate |
| `payout_initiated` | Partner sent the bank transfer; `partner_reference` set |
| `completed` | Partner confirmed settlement; `fiat_amount_paid` set; `offramp.completed` fired |
| `failed` | Partner rejected / failed; `failure_reason`; `offramp.failed` fired. Funds are at the partner in your account - resolve there. |
| `cancelled` | You cancelled before depositing; credits refunded |
| `expired` | Deposit not made in time; credits refunded |

Rates on `converting` can differ slightly from the quote if the partner does not support
firm quotes; `fiat_amount_paid` is authoritative.

## Fees

A flat 20 credits per payout job ($0.20 nominal; refunded if cancelled or expired before the deposit) plus the partner's own fees (shown in the quote) and your network fee
for the deposit. CoinVello takes no cut of the fiat.

## Scheduled payouts

The dashboard can create payouts on a schedule (e.g. every Friday, everything above 500 USDC)
- each one still lands in `awaiting_deposit` for you to sign, unless you have a browser
wallet session or signing webhook configured. Nothing moves without your signature.
