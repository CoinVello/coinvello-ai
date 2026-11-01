# Wallets and xpubs

CoinVello never asks for a private key, seed phrase or `xprv`. You register either:

* an **extended public key (xpub)** for Bitcoin - CoinVello derives a fresh,
  never-reused address for every invoice, and funds land straight in your wallet; or
* a **receiving address** for Ethereum & EVM chains, Solana and Tron - CoinVello watches it.

Requests that contain anything that looks like a private key (`xprv`, `zprv`, a 64-hex key, a
12/24-word phrase) are rejected with `422 xprv_rejected` and the material is discarded
without being logged. If that happens, treat the key as compromised and move the funds.

## Why xpubs for UTXO chains

Bitcoin has no memos and address reuse hurts privacy and matching. With an
xpub, CoinVello computes `account_xpub / 0 / index` for each invoice (BIP-32 non-hardened
derivation; external chain `0`), so every customer gets a unique address and CoinVello can
attribute payments exactly. It cannot spend: public derivation yields public keys only.

Exposing an xpub does reveal your **account's full transaction history** to CoinVello.
Create a dedicated account (e.g. `m/84'/0'/1'`) for your shop if you want to keep other
activity private.

## Supported formats

| Chain | Prefixes accepted | Script type | Default path |
|-------|-------------------|-------------|--------------|
| bitcoin | `zpub` | p2wpkh (native segwit, `bc1q`) | `m/84'/0'/0'` |
| bitcoin | `ypub` | p2sh-p2wpkh (wrapped segwit, `3...`) | `m/49'/0'/0'` |
| bitcoin | `xpub` + `address_type: p2tr` | p2tr (taproot, `bc1p`) | `m/86'/0'/0'` |
| bitcoin | `xpub` | p2pkh (legacy, `1...`) | `m/44'/0'/0'` |
| bitcoin testnet4 | `vpub`, `upub`, `tpub` | as above | `m/84'/1'/0'` etc. |

Output descriptors are also accepted and are the least ambiguous option:
`wpkh([d34db33f/84h/0h/0h]zpub6rFR.../0/*)`. CoinVello reads the fingerprint, path and
script type from it.

`derivation_path` is the **account-level** path the key was exported at. CoinVello appends
`/0/<index>`. If you omit it, the default for the prefix/script type is used.

Multisig (`wsh(sortedmulti(...))`) descriptors are supported on request; contact support.

## Exporting an xpub from common wallets

| Wallet | Steps |
|--------|-------|
| **Ledger (Ledger Live)** | Accounts -> pick the BTC account -> wrench icon -> *Advanced* -> copy **xpub**. Ledger Live shows an `xpub`-prefixed key even for native segwit accounts; register it with `address_type: p2wpkh` and `derivation_path: m/84'/0'/0'` (or convert to `zpub`). |
| **Trezor (Suite)** | Account -> *Account details* tab -> *Show public key (XPUB)*. Native segwit accounts show `zpub`. |
| **Sparrow** | Settings (of the wallet) -> *Script Policy* shows the descriptor; or *Export...* -> *Output Descriptor*. Paste the descriptor directly. |
| **Electrum** | Wallet -> *Information* -> *Master Public Key*. Prefix tells the type (`zpub` native segwit). Path shown next to it. |
| **BlueWallet** | Wallet -> ... -> *Export/Backup* -> *XPUB* (shows a QR and text). Native segwit HD wallets give `zpub`. |
| **Coldcard** | Advanced/Tools -> *Export Wallet* -> *Generic JSON* (contains xpub/ypub/zpub per path with fingerprint). |
| **BitBox02 (BitBoxApp)** | Account -> ... -> *Show extended public key*. |
| **Keystone** | Watch-only export -> *Generic* -> shows `zpub`; or scan with Sparrow and export the descriptor. |
| **Bitcoin Core** | `bitcoin-cli listdescriptors` -> copy the `wpkh(...)` descriptor with `/0/*`. Replace any `xprv` with the corresponding `xpub` (use `listdescriptors` without `true`). |
| **Wasabi** | Wallet info -> *Extended account public key*. |
| **Exodus / Trust / Coinbase Wallet** | Do not expose xpubs. Use a different wallet for the shop account, or import the same seed into Sparrow/Electrum (watch-only is not possible without the xpub). |

## Guides for merchants

Step-by-step, non-technical setup guides live on the website and end with the dashboard steps and the
first-address check described below:

* [Choosing a wallet for your business](https://coinvello.com/guides/choosing-a-wallet)
* [Electrum for Bitcoin](https://coinvello.com/guides/electrum) (zpub export, gap limit, watch-only)
* [MetaMask for Ethereum and EVM chains](https://coinvello.com/guides/metamask) (networks, one address on eight chains, signing)
* [Ledger and Trezor](https://coinvello.com/guides/hardware-wallets) (xpub export, device address, signing with the device)
* [Phantom for Solana and TronLink for Tron](https://coinvello.com/guides/phantom-tronlink)

Index: https://coinvello.com/guides

## Registering

```bash
curl https://api.coinvello.com/v1/wallets \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{
    "type": "xpub",
    "chain": "bitcoin",
    "label": "Shop BTC (Trezor)",
    "xpub": "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs",
    "derivation_path": "m/84'"'"'/0'"'"'/0'"'"'",
    "address_type": "p2wpkh",
    "start_index": 0
  }'
```

`start_index` lets you skip addresses you have already handed out elsewhere. The response
includes `verification.signing_address` - the first derived address - which you should
compare against your wallet's first receive address **before** going live. If they differ,
the path or script type is wrong.

`GET /wallets/{id}/addresses` lists every derived address and the invoice it was used for,
for reconciliation against your wallet software. Keep your wallet's gap limit above the
number of concurrently open invoices (Electrum default 20; raise to 100+ for busy shops, or
use `payment_options_mode: single` on invoices so an address is only derived when the
customer actually picks BTC).

## Address wallets (EVM, Solana, Tron)

```bash
curl https://api.coinvello.com/v1/wallets \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{
    "type": "address",
    "chain": "ethereum",
    "label": "Treasury ETH",
    "address": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "assets": ["eth:ethereum", "usdc:ethereum", "usdt:ethereum"]
  }'
```

One address serves all listed assets on that chain. Because the address is reused, CoinVello
matches payments by **exact amount**: when two open invoices on the same asset would collide,
the second gets a tiny unique "amount tag" appended (e.g. `50.000518` vs `50.000519`). On
Solana the payment URI also carries a unique `reference` key.

Use a **fresh address per chain for your shop**, not your personal wallet, so unrelated
inbound transfers don't confuse matching (they are recorded as unmatched payments visible in
the dashboard, never applied to invoices).

Smart-contract wallets (Safe, Argent) work as receiving addresses. Exchange deposit
addresses do **not** - they often require memos and may be rotated by the exchange.

Register the same EVM address on several chains in one call with `chains` instead of `chain`:

```bash
curl https://api.coinvello.com/v1/wallets \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{
    "type": "address",
    "chains": ["ethereum", "base", "arbitrum", "optimism", "polygon", "bnb", "avalanche", "robinhood"],
    "label": "Treasury EVM",
    "address": "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
    "assets": ["eth:ethereum", "usdc:ethereum", "usdt:ethereum"]
  }'
```

This creates one wallet per chain atomically, all sharing a `group_id` (`wgr_...`) and the label;
the response is a list of the wallets. `assets` is applied per chain by symbol (USDC on every chain
that has it in the wallet's mode, the chain's native coin where a symbol is missing). Only EVM chains may share an
address: a non-EVM chain in `chains`, or `chains` with `type: xpub`, returns `422 chains_not_compatible`.
`GET /wallets?group_id=wgr_...` lists a group. If you use the optional verification (below), one
challenge on any member verifies every member, since they share the key.

An existing EVM address wallet can be extended later: `POST /wallets/{id}/chains {"chains": [...],
"assets"?: [...]}` creates siblings for the new chains (already-covered chains are skipped), joins them
to the wallet's group (creating one if needed), copies label, enabled and assets, and passes an
optionally verified wallet's verification on to the siblings. `GET /wallets/{id}` returns `group_chains`, the chains the
group already covers.

## Address checks (what protects you from typos)

A new wallet is **active immediately**, in live and test mode. The control on who may add or change
a wallet is the dashboard's 2FA step-up (below) and the owner email on API-key changes; the control
on *what* you add is strict validation, so a typo or a wrong copy-paste is refused instead of
silently becoming where customer money goes (`422 address_invalid`, `param` names the field):

| Chain | Checked |
|-------|---------|
| EVM (ethereum, base, arbitrum, optimism, polygon, bnb, avalanche, robinhood) | `0x` + 40 hex; when mixed-case, the EIP-55 checksum must match (send all lower-case if your source has no checksum). Refused: the zero address, precompiles, well-known burn addresses, and token contracts (pasting the USDC contract instead of your wallet is a common, costly mistake). |
| tron | base58check, 21 bytes with the `0x41` prefix (`T...`). Refused: the zero address and token contracts. Hex (`41...`) is not accepted. |
| solana | base58 that decodes to a 32-byte public key. Refused: system/token programs, the incinerator, token mints. Program-derived addresses (for example a Squads multisig vault) are accepted. |
| bitcoin | xpub only (`422 xpub_required` for a single address), checked against the mode's network: a mainnet xpub is refused in test mode and vice versa. The response's `first_address` is the first address CoinVello will derive - compare it with your wallet's first receive address before going live. A plain address sent by mistake is still decoded (bech32, bech32m, base58check) so a wrong-network address gets a precise message. |

## Optional: prove ownership with a signed message

Not required for anything, in live or test mode. Signing a challenge marks the wallet `verified`
(`verification.status`, `wallet.verified` event) as your own proof, for example for an internal
audit. New wallets show `verification.status: not_required`.

```bash
# 1. get a challenge
curl -X POST https://api.coinvello.com/v1/wallets/wal_btc_7Lm3Qp/verification \
  -H "Authorization: Bearer cv_live_..."
```

```json
{
  "id": "wvc_3kd9Fj2L",
  "message": "CoinVello wallet verification\nWallet: wal_btc_7Lm3Qp\nAddress: bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4\nNonce: 7f3a9c1e\nExpires: 2026-10-21T10:15:00Z",
  "signing_address": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  "scheme": "bip137",
  "expires_at": "2026-10-21T10:15:00Z"
}
```

```bash
# 2. sign `message` with the key for signing_address, then submit
curl -X POST https://api.coinvello.com/v1/wallets/wal_btc_7Lm3Qp/verify \
  -H "Authorization: Bearer cv_live_..." -H "Content-Type: application/json" \
  -d '{"signature": "J4Qb...base64..."}'
```

| Chain | Scheme | How to sign |
|-------|--------|-------------|
| bitcoin | `bip137` (Bitcoin signed message) | Sparrow: Tools -> Sign/Verify Message, pick the address. Electrum: Tools -> Sign/verify message. Trezor Suite: Sign & Verify. Ledger: via Sparrow/Electrum. Coldcard: Advanced -> Sign Text File. |
| ethereum & EVM | `eip191` (`personal_sign`) | MetaMask / Rabby / WalletConnect: the dashboard has a one-click "Sign with wallet" button. Smart-contract wallets (Safe) cannot produce this signature; they simply stay `not_required`, which is fine. |
| solana | `ed25519` over UTF-8 bytes | Phantom / Solflare `signMessage`; dashboard button. |
| tron | `tip191` (`signMessageV2`) | TronLink `signMessageV2`; dashboard button. |

The dashboard wraps all of this in a UI; the API exists so plugins and scripts can do it
headlessly. Verification does not expire.

## Two-factor step-up

Wallets decide where customer money goes, so in the **dashboard** every wallet change
(add, edit, archive, and the optional verify) requires a recent second-factor verification - a 5-minute
"step-up" window after `POST /auth/mfa/verify` - even if the account does not use 2FA at
login. API-key calls to `/wallets` are gated by the `wallets:write` scope and trigger an
owner email with a one-click revoke link. Details in [security.md](security.md).

## Lifecycle

* `PATCH /wallets/{id}` - rename, change `assets`, toggle `enabled`. `assets` replaces the list: it needs at least
  one asset, each on the wallet's chain and listed by `GET /assets` for the wallet's mode (some tokens are
  live-only, see [testing.md](testing.md)). In the dashboard, each wallet has a checkbox per asset (all ticked by default).
* `DELETE /wallets/{id}` - archive. New invoices stop using it; existing addresses are still
  watched indefinitely so late payments are detected.
* Rotating to a new xpub: register the new one, verify it, enable it, then archive the old one.
