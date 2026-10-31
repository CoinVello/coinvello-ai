/**
 * In-memory state and domain logic for the mock server. Mirrors api/openapi.yaml shapes.
 * Deterministic enough for plugin CI, loose enough to stay small.
 */
import { createHmac, randomBytes } from "node:crypto";

export const API_VERSION = "2026-10-01";

export type Chain = "bitcoin" | "ethereum" | "base" | "arbitrum" | "optimism" | "polygon" | "bnb" | "avalanche" | "robinhood" | "solana" | "tron";

export interface AssetDef {
  id: string; symbol: string; name: string; chain: Chain; kind: "native" | "token";
  contract_address: string | null; decimals: number; required_confirmations: number; min_amount: string;
  network_id: string | null; rate_usd: number; testnet: string;
}

/** Per-chain network ids (decimal EVM chain id) per mode and the test network name. */
const NETWORKS: Record<Chain, { live: string | null; test: string | null; testnet: string }> = {
  bitcoin: { live: null, test: null, testnet: "testnet4" },
  ethereum: { live: "1", test: "11155111", testnet: "sepolia" },
  base: { live: "8453", test: "84532", testnet: "base-sepolia" },
  arbitrum: { live: "42161", test: "421614", testnet: "arbitrum-sepolia" },
  optimism: { live: "10", test: "11155420", testnet: "optimism-sepolia" },
  polygon: { live: "137", test: "80002", testnet: "amoy" },
  bnb: { live: "56", test: "97", testnet: "bnb-testnet" },
  avalanche: { live: "43114", test: "43113", testnet: "fuji" },
  robinhood: { live: "4663", test: "46630", testnet: "robinhood-testnet" },
  solana: { live: null, test: null, testnet: "devnet" },
  tron: { live: null, test: null, testnet: "nile" },
};

interface CatalogueAsset {
  id: string; symbol: string; name: string; kind: "native" | "token"; decimals: number;
  contract: { live: string | null; test: string | null }; required_confirmations: number; min_amount: string; rate_usd: number;
}

/**
 * Mirrors backend/src/domain/assets.ts. A token exists in a mode only where it has a contract there: tokens with
 * `test: null` have no official testnet deployment, so they are live-only (not listed or accepted in test mode).
 */
const CATALOGUE: CatalogueAsset[] = [
  { id: "btc:bitcoin", symbol: "BTC", name: "Bitcoin", kind: "native", decimals: 8, contract: { live: null, test: null }, required_confirmations: 1, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "eth:ethereum", symbol: "ETH", name: "Ether", kind: "native", decimals: 18, contract: { live: null, test: null }, required_confirmations: 12, min_amount: "0.0005", rate_usd: 2510.44 },
  { id: "usdc:ethereum", symbol: "USDC", name: "USD Coin (ERC-20)", kind: "token", decimals: 6, contract: { live: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", test: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9999 },
  { id: "usdt:ethereum", symbol: "USDT", name: "Tether USD (ERC-20)", kind: "token", decimals: 6, contract: { live: "0xdAC17F958D2ee523a2206206994597C13D831ec7", test: "0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0" }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9998 },
  { id: "dai:ethereum", symbol: "DAI", name: "Dai (ERC-20)", kind: "token", decimals: 18, contract: { live: "0x6B175474E89094C44Da98b954EedeAC495271d0F", test: null }, required_confirmations: 12, min_amount: "1", rate_usd: 1.0 },
  { id: "eurc:ethereum", symbol: "EURC", name: "Euro Coin (ERC-20)", kind: "token", decimals: 6, contract: { live: "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", test: "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4" }, required_confirmations: 12, min_amount: "1", rate_usd: 1.16 },
  { id: "pyusd:ethereum", symbol: "PYUSD", name: "PayPal USD (ERC-20)", kind: "token", decimals: 6, contract: { live: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", test: "0xCaC524BcA292aaade2DF8A05cC58F0a65B1B3bB9" }, required_confirmations: 12, min_amount: "1", rate_usd: 1.0 },
  { id: "wbtc:ethereum", symbol: "WBTC", name: "Wrapped BTC (ERC-20)", kind: "token", decimals: 8, contract: { live: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", test: null }, required_confirmations: 12, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "cbbtc:ethereum", symbol: "cbBTC", name: "Coinbase Wrapped BTC (ERC-20)", kind: "token", decimals: 8, contract: { live: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", test: null }, required_confirmations: 12, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "eth:base", symbol: "ETH", name: "Ether (Base)", kind: "native", decimals: 18, contract: { live: null, test: null }, required_confirmations: 12, min_amount: "0.0005", rate_usd: 2510.44 },
  { id: "usdc:base", symbol: "USDC", name: "USD Coin (Base)", kind: "token", decimals: 6, contract: { live: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", test: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9999 },
  { id: "usdt:base", symbol: "USDT", name: "Tether USD (Base)", kind: "token", decimals: 6, contract: { live: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", test: null }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9998 },
  { id: "dai:base", symbol: "DAI", name: "Dai (Base)", kind: "token", decimals: 18, contract: { live: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", test: null }, required_confirmations: 12, min_amount: "1", rate_usd: 1.0 },
  { id: "eurc:base", symbol: "EURC", name: "Euro Coin (Base)", kind: "token", decimals: 6, contract: { live: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", test: "0x808456652fdb597867f38412077A9182bf77359F" }, required_confirmations: 12, min_amount: "1", rate_usd: 1.16 },
  { id: "wbtc:base", symbol: "WBTC", name: "Wrapped BTC (Base)", kind: "token", decimals: 8, contract: { live: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", test: null }, required_confirmations: 12, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "cbbtc:base", symbol: "cbBTC", name: "Coinbase Wrapped BTC (Base)", kind: "token", decimals: 8, contract: { live: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", test: null }, required_confirmations: 12, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "eth:arbitrum", symbol: "ETH", name: "Ether (Arbitrum)", kind: "native", decimals: 18, contract: { live: null, test: null }, required_confirmations: 12, min_amount: "0.0005", rate_usd: 2510.44 },
  { id: "usdc:arbitrum", symbol: "USDC", name: "USD Coin (Arbitrum)", kind: "token", decimals: 6, contract: { live: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", test: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9999 },
  { id: "usdt:arbitrum", symbol: "USDT", name: "Tether USD (Arbitrum)", kind: "token", decimals: 6, contract: { live: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", test: null }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9998 },
  { id: "dai:arbitrum", symbol: "DAI", name: "Dai (Arbitrum)", kind: "token", decimals: 18, contract: { live: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", test: null }, required_confirmations: 12, min_amount: "1", rate_usd: 1.0 },
  { id: "wbtc:arbitrum", symbol: "WBTC", name: "Wrapped BTC (Arbitrum)", kind: "token", decimals: 8, contract: { live: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", test: null }, required_confirmations: 12, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "cbbtc:arbitrum", symbol: "cbBTC", name: "Coinbase Wrapped BTC (Arbitrum)", kind: "token", decimals: 8, contract: { live: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", test: null }, required_confirmations: 12, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "eth:optimism", symbol: "ETH", name: "Ether (Optimism)", kind: "native", decimals: 18, contract: { live: null, test: null }, required_confirmations: 12, min_amount: "0.0005", rate_usd: 2510.44 },
  { id: "usdc:optimism", symbol: "USDC", name: "USD Coin (Optimism)", kind: "token", decimals: 6, contract: { live: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", test: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9999 },
  { id: "usdt:optimism", symbol: "USDT", name: "Tether USD (Optimism)", kind: "token", decimals: 6, contract: { live: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", test: null }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9998 },
  { id: "dai:optimism", symbol: "DAI", name: "Dai (Optimism)", kind: "token", decimals: 18, contract: { live: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", test: null }, required_confirmations: 12, min_amount: "1", rate_usd: 1.0 },
  { id: "wbtc:optimism", symbol: "WBTC", name: "Wrapped BTC (Optimism)", kind: "token", decimals: 8, contract: { live: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", test: null }, required_confirmations: 12, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "pol:polygon", symbol: "POL", name: "Polygon", kind: "native", decimals: 18, contract: { live: null, test: null }, required_confirmations: 64, min_amount: "1", rate_usd: 0.41 },
  { id: "usdc:polygon", symbol: "USDC", name: "USD Coin (Polygon)", kind: "token", decimals: 6, contract: { live: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", test: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" }, required_confirmations: 64, min_amount: "1", rate_usd: 0.9999 },
  { id: "usdt:polygon", symbol: "USDT", name: "Tether USD (Polygon)", kind: "token", decimals: 6, contract: { live: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", test: "0x1616d425Cd540B256475cBfb604586C8598eC0FB" }, required_confirmations: 64, min_amount: "1", rate_usd: 0.9998 },
  { id: "dai:polygon", symbol: "DAI", name: "Dai (Polygon)", kind: "token", decimals: 18, contract: { live: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", test: null }, required_confirmations: 64, min_amount: "1", rate_usd: 1.0 },
  { id: "wbtc:polygon", symbol: "WBTC", name: "Wrapped BTC (Polygon)", kind: "token", decimals: 8, contract: { live: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", test: null }, required_confirmations: 64, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "bnb:bnb", symbol: "BNB", name: "BNB", kind: "native", decimals: 18, contract: { live: null, test: null }, required_confirmations: 15, min_amount: "0.005", rate_usd: 590.1 },
  { id: "usdt:bnb", symbol: "USDT", name: "Tether USD (BEP-20)", kind: "token", decimals: 18, contract: { live: "0x55d398326f99059fF775485246999027B3197955", test: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd" }, required_confirmations: 15, min_amount: "1", rate_usd: 0.9998 },
  { id: "usdc:bnb", symbol: "USDC", name: "USD Coin (BEP-20)", kind: "token", decimals: 18, contract: { live: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", test: null }, required_confirmations: 15, min_amount: "1", rate_usd: 0.9999 },
  { id: "btcb:bnb", symbol: "BTCB", name: "Binance-Peg BTC (BEP-20)", kind: "token", decimals: 18, contract: { live: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", test: null }, required_confirmations: 15, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "avax:avalanche", symbol: "AVAX", name: "Avalanche", kind: "native", decimals: 18, contract: { live: null, test: null }, required_confirmations: 12, min_amount: "0.05", rate_usd: 24.6 },
  { id: "usdc:avalanche", symbol: "USDC", name: "USD Coin (Avalanche)", kind: "token", decimals: 6, contract: { live: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", test: "0x5425890298aed601595a70AB815c96711a31Bc65" }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9999 },
  { id: "usdt:avalanche", symbol: "USDT", name: "Tether USD (Avalanche)", kind: "token", decimals: 6, contract: { live: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", test: null }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9998 },
  { id: "eurc:avalanche", symbol: "EURC", name: "Euro Coin (Avalanche)", kind: "token", decimals: 6, contract: { live: "0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD", test: "0x5E44db7996c682E92a960b65AC713a54AD815c6B" }, required_confirmations: 12, min_amount: "1", rate_usd: 1.16 },
  { id: "btcb:avalanche", symbol: "BTC.b", name: "Bitcoin (Avalanche bridge)", kind: "token", decimals: 8, contract: { live: "0x152b9d0FdC40C096757F570A51E494bd4b943E50", test: null }, required_confirmations: 12, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "eth:robinhood", symbol: "ETH", name: "Ether (Robinhood Chain)", kind: "native", decimals: 18, contract: { live: null, test: null }, required_confirmations: 12, min_amount: "0.0005", rate_usd: 2510.44 },
  { id: "usdg:robinhood", symbol: "USDG", name: "Global Dollar (Robinhood Chain)", kind: "token", decimals: 6, contract: { live: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", test: "0x8F9231B0F448bA9AD045348437458721676c23BC" }, required_confirmations: 12, min_amount: "1", rate_usd: 0.9999 },
  { id: "sol:solana", symbol: "SOL", name: "Solana", kind: "native", decimals: 9, contract: { live: null, test: null }, required_confirmations: 32, min_amount: "0.01", rate_usd: 152.3 },
  { id: "usdc:solana", symbol: "USDC", name: "USD Coin (SPL)", kind: "token", decimals: 6, contract: { live: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", test: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }, required_confirmations: 32, min_amount: "1", rate_usd: 0.9999 },
  { id: "usdt:solana", symbol: "USDT", name: "Tether USD (SPL)", kind: "token", decimals: 6, contract: { live: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", test: null }, required_confirmations: 32, min_amount: "1", rate_usd: 0.9998 },
  { id: "eurc:solana", symbol: "EURC", name: "Euro Coin (SPL)", kind: "token", decimals: 6, contract: { live: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", test: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr" }, required_confirmations: 32, min_amount: "1", rate_usd: 1.16 },
  { id: "cbbtc:solana", symbol: "cbBTC", name: "Coinbase Wrapped BTC (SPL)", kind: "token", decimals: 8, contract: { live: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", test: null }, required_confirmations: 32, min_amount: "0.00005", rate_usd: 67350.12 },
  { id: "trx:tron", symbol: "TRX", name: "Tron", kind: "native", decimals: 6, contract: { live: null, test: null }, required_confirmations: 19, min_amount: "10", rate_usd: 0.16 },
  { id: "usdt:tron", symbol: "USDT", name: "Tether USD (TRC-20)", kind: "token", decimals: 6, contract: { live: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", test: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf" }, required_confirmations: 19, min_amount: "1", rate_usd: 0.9998 },
];

export const availableIn = (a: CatalogueAsset, livemode: boolean) => a.kind === "native" || !!(livemode ? a.contract.live : a.contract.test);

/** The assets of one mode, as `GET /assets` lists them. */
export function assetsFor(livemode: boolean): AssetDef[] {
  return CATALOGUE.filter((a) => availableIn(a, livemode)).map((a) => {
    const chain = a.id.split(":")[1] as Chain;
    const net = NETWORKS[chain];
    return {
      id: a.id, symbol: a.symbol, name: a.name, chain, kind: a.kind, contract_address: livemode ? a.contract.live : a.contract.test,
      decimals: a.decimals, required_confirmations: a.required_confirmations, min_amount: a.min_amount,
      network_id: livemode ? net.live : net.test, rate_usd: a.rate_usd, testnet: net.testnet,
    };
  });
}

/** The reference server runs in test mode only: everything else (wallets, invoices, rates) uses the test catalogue. */
export const ASSETS: AssetDef[] = assetsFor(false);

export const FIAT_RATES_USD: Record<string, number> = { USD: 1, EUR: 1.0875, GBP: 1.29, CAD: 0.73, AUD: 0.66, CHF: 1.13, JPY: 0.0066 };

/** Display/reporting currencies, units per 1 USD (also the pivot for records re-valuation). */
export const DISPLAY_PER_USD: Record<string, number> = { USD: 1, EUR: 0.9195, GBP: 0.7752, CAD: 1.3699, AUD: 1.5152, JPY: 151.52, CHF: 0.885, SGD: 1.3333, AED: 3.6725, BRL: 5.5556, MXN: 18.5185, ZAR: 18.1818, INR: 83.3333, PLN: 4.0, SEK: 10.5263, NOK: 10.8696, DKK: 6.8493, CZK: 23.2558, NZD: 1.6667, HKD: 7.8125, KRW: 1370.0, TRY: 34.4828, ILS: 3.7, THB: 34.5, PHP: 57.5, IDR: 15800.0, MYR: 4.45, VND: 25300.0, NGN: 1550.0, ARS: 1050.0 };

export const EXPLORERS: Record<string, { address: string; tx: string }> = {
  bitcoin: { address: "https://mempool.space/testnet4/address/", tx: "https://mempool.space/testnet4/tx/" },
  ethereum: { address: "https://sepolia.etherscan.io/address/", tx: "https://sepolia.etherscan.io/tx/" },
  base: { address: "https://sepolia.basescan.org/address/", tx: "https://sepolia.basescan.org/tx/" },
  arbitrum: { address: "https://sepolia.arbiscan.io/address/", tx: "https://sepolia.arbiscan.io/tx/" },
  optimism: { address: "https://sepolia-optimism.etherscan.io/address/", tx: "https://sepolia-optimism.etherscan.io/tx/" },
  polygon: { address: "https://amoy.polygonscan.com/address/", tx: "https://amoy.polygonscan.com/tx/" },
  bnb: { address: "https://testnet.bscscan.com/address/", tx: "https://testnet.bscscan.com/tx/" },
  avalanche: { address: "https://testnet.snowtrace.io/address/", tx: "https://testnet.snowtrace.io/tx/" },
  robinhood: { address: "https://explorer.testnet.chain.robinhood.com/address/", tx: "https://explorer.testnet.chain.robinhood.com/tx/" },
  solana: { address: "https://explorer.solana.com/address/", tx: "https://explorer.solana.com/tx/" },
  tron: { address: "https://nile.tronscan.org/#/address/", tx: "https://nile.tronscan.org/#/transaction/" },
};
export const explorer = (chain: string, kind: "address" | "tx", v: string) => (EXPLORERS[chain] ? EXPLORERS[chain][kind] + v + (chain === "solana" ? "?cluster=devnet" : "") : null);

// ----------------------------------------------------------------- ids & time
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
export function id(prefix: string, len = 10): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${out}`;
}
export const now = () => new Date().toISOString();
export const plusSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

// ----------------------------------------------------------------- decimals (string math on integers)
export function toMinor(amount: string, decimals: number): bigint {
  const neg = amount.startsWith("-");
  const [i, f = ""] = amount.replace("-", "").split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  const v = BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return neg ? -v : v;
}
export function fromMinor(v: bigint, decimals: number): string {
  const neg = v < 0n; if (neg) v = -v;
  const s = v.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals);
  return (neg ? "-" : "") + (decimals ? `${i}.${f}` : i);
}
export function fiatToAsset(amountFiat: string, fiat: string, asset: AssetDef): { amount: string; amount_minor: string; rate: string } {
  const usd = Number(amountFiat) * (FIAT_RATES_USD[fiat] ?? 1);
  const units = usd / asset.rate_usd;
  const minor = BigInt(Math.round(units * 10 ** asset.decimals));
  const rateInFiat = asset.rate_usd / (FIAT_RATES_USD[fiat] ?? 1);
  return { amount: fromMinor(minor, asset.decimals), amount_minor: minor.toString(), rate: rateInFiat.toFixed(asset.rate_usd > 10 ? 2 : 4) };
}

// ----------------------------------------------------------------- addresses
const HEX = "0123456789abcdef";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const rnd = (alphabet: string, n: number) => Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
export function fakeAddress(chain: Chain, index = 0): string {
  switch (chain) {
    case "bitcoin": return "tb1q" + rnd("qpzry9x8gf2tvdw0s3jn54khce6mua7l", 38);
    case "solana": return rnd(B58, 44);
    case "tron": return "T" + rnd(B58, 33);
    default: return "0x" + rnd(HEX, 40);
  }
}
export function fakeTxHash(chain: Chain): string {
  if (chain === "solana") return rnd(B58, 88);
  const h = rnd(HEX, 64);
  return chain === "bitcoin" || chain === "tron" ? h : "0x" + h;
}

export function paymentUri(asset: AssetDef, address: string, amount: string, amountMinor: string, label?: string): { payment_uri: string; qr_payload: string; memo: string | null } {
  const lbl = label ? `&label=${encodeURIComponent(label)}` : "";
  switch (asset.chain) {
    case "bitcoin": { const u = `bitcoin:${address}?amount=${amount}${lbl}`; return { payment_uri: u, qr_payload: u, memo: null }; }
    case "solana": {
      const ref = rnd(B58, 44);
      const u = `solana:${address}?amount=${amount}${asset.contract_address ? `&spl-token=${asset.contract_address}` : ""}&reference=${ref}${lbl}`;
      return { payment_uri: u, qr_payload: u, memo: ref };
    }
    case "tron": {
      const u = `tron:${address}?amount=${amount}${asset.contract_address ? `&token=${asset.contract_address}` : ""}`;
      return { payment_uri: u, qr_payload: address, memo: null };
    }
    default: {
      const u = asset.contract_address
        ? `ethereum:${asset.contract_address}@${asset.network_id}/transfer?address=${address}&uint256=${amountMinor}`
        : `ethereum:${address}@${asset.network_id}?value=${amountMinor}`;
      return { payment_uri: u, qr_payload: u, memo: null };
    }
  }
}

// ----------------------------------------------------------------- records
export type InvoiceStatus = "new" | "pending" | "confirming" | "paid" | "underpaid" | "overpaid" | "expired" | "cancelled" | "refund_requested";

export interface PaymentOption {
  asset: string; symbol: string; chain: Chain; network_id: string | null; wallet_id: string; address: string;
  derivation_path: string | null; contract_address: string | null; decimals: number; amount: string; amount_minor: string;
  rate: string; payment_uri: string; qr_payload: string; memo: string | null; required_confirmations: number; status: string;
}

export interface Payable {
  status: InvoiceStatus;
  amount: string; currency: string;
  payment_options: PaymentOption[];
  paid: null | { asset: string | null; amount_received: string; amount_received_fiat: string; amount_due: string; amount_remaining: string; confirmations: number; required_confirmations: number; payment_ids: string[] };
  underpayment_tolerance: string; overpayment_tolerance: string;
  expires_at: string; paid_at: string | null;
}

export interface Invoice extends Payable {
  id: string; object: "invoice"; livemode: false; pricing: "fiat" | "crypto"; accepted_assets: string[];
  order_id: string | null; description: string | null; customer: Record<string, string> | undefined;
  success_url: string | null; cancel_url: string | null; hosted_url: string; refund_claim_url: string | null;
  rate_lock: { id: string; locked: boolean; locked_until: string; rates: Record<string, string> };
  required_confirmations: Record<string, number>; checkout_session_id: string | null;
  fee: { credits: number; bps: number; fiat_value_usd: string; ledger_entry_id: string | null } | null;
  tax: InvoiceTax | null;
  metadata: Record<string, string>; created_at: string; updated_at: string;
}

export interface InvoiceTax { amount: string; rate: string | null; label: string | null; jurisdiction: string | null }

// ----------------------------------------------------------------- records & exports (docs/10-records-and-tax.md)
export type RecordType = "payment_received" | "payment_reversed" | "refund_sent" | "fee_prepaid" | "fee_onchain" | "credit_purchase" | "credit_adjustment" | "conversion" | "offramp_payout";
export interface RecordLeg { asset: string; amount: string; amount_minor: string | null }
export interface RecordValue {
  currency: string; amount: string; rate: string | null; rate_as_of: string | null;
  source: { provider: string; method: string | null; venues: string[]; snapshot_id: string | null };
}
/** Stored in USD; `GET /records?currency=` and the exports re-value from `value_usd`. */
export interface AccountingRecord {
  id: string; object: "record"; livemode: false; type: RecordType; occurred_at: string; recorded_at: string; description: string;
  received: RecordLeg | null; sent: RecordLeg | null; fee: RecordLeg | null;
  chain: Chain | null; tx_hash: string | null; tx_index: number | null; block_height: number | null; from_address: string | null; to_address: string | null;
  derivation_path: string | null; explorer_url: string | null;
  contract_value: RecordValue | null; value: RecordValue; value_usd: string; tax: InvoiceTax | null; credits: number | null;
  invoice: { id: string; status: InvoiceStatus; order_id: string | null; description: string | null; amount: string; currency: string; pricing: "fiat" | "crypto"; checkout_session_id: string | null; customer_reference: string | null } | null;
  related: Record<string, unknown>; reverses_record_id: string | null; flags: string[]; simulated: boolean; metadata: Record<string, string>;
}

export interface ExportObject {
  id: string; object: "export"; livemode: false; status: "queued" | "processing" | "ready" | "failed" | "expired";
  dataset: string; format: string; preset: string; period: { start: string; end: string } | null; timezone: string; currency: string; include_simulated: boolean;
  rows: number | null; file: { name: string; content_type: string; bytes: number; sha256: string } | null;
  download_url: string | null; download_expires_at: string | null; failure_reason: string | null; metadata: Record<string, string>;
  created_at: string; completed_at: string | null;
}

export interface Payment {
  id: string; object: "payment"; livemode: false; invoice_id: string; asset: string; chain: Chain; tx_hash: string; tx_index: number;
  from_address: string; to_address: string; amount: string; amount_minor: string; amount_fiat: string;
  status: "detected" | "confirming" | "confirmed" | "failed"; confirmations: number; required_confirmations: number;
  block_height: number | null; block_hash: string | null; simulated: true; detected_at: string; confirmed_at: string | null; created_at: string; updated_at: string;
}

export interface Webhook {
  id: string; object: "webhook"; livemode: false; url: string; description: string | null; events: string[]; enabled: boolean;
  secret: string; api_version: string; status: "active" | "degraded" | "disabled"; last_delivery_at: string | null; created_at: string; updated_at: string;
}

export interface Delivery {
  id: string; object: "webhook_delivery"; webhook_id: string; event_id: string; event_type: string; attempt: number;
  status: "pending" | "succeeded" | "failed" | "exhausted"; response_status: number | null; error: string | null; duration_ms: number | null; next_retry_at: string | null; replayed: boolean; created_at: string;
}

export interface Event { id: string; object: "event"; type: string; livemode: false; api_version: string; created_at: string; data: Record<string, unknown>; request: { id: string | null; idempotency_key: string | null }; pending_webhooks: number }

export interface CheckoutSession {
  id: string; object: "checkout_session"; livemode: false; status: "open" | "complete" | "expired"; url: string; invoice_id: string;
  invoice_status: InvoiceStatus; amount: string; currency: string; order_id: string | null; success_url: string; cancel_url: string | null;
  redirect_on: "confirming" | "paid"; line_items: unknown[]; customer: Record<string, string> | undefined; selected_asset: string | null;
  metadata: Record<string, string>; expires_at: string; completed_at: string | null; created_at: string;
}

export interface CreditPurchase {
  method: "crypto" | "card";
  card: { payment_method: string; brand: string; last4: string; auto_topup: boolean } | null;
  failure: { code: string; message: string } | null;
  id: string; object: "credit_purchase"; livemode: false; status: InvoiceStatus; bundle_id: string; credits: number;
  price: { amount: string; currency: "USD" }; list_price: { amount: string; currency: "USD" }; discount: { type: "stablecoin"; bps: number } | null;
  payment: Payable & { rate_locked_until: string; payment_ids: string[] };
  checkout_url: string; credits_added_at: string | null; ledger_entry_id: string | null; metadata: Record<string, string>; created_at: string; updated_at: string;
}

export interface Bundle { id: string; object: "credit_bundle"; name: string; description: string | null; credits: number; bonus_credits: number; monthly: boolean; price: { amount: string; currency: "USD" }; price_per_credit: string | null; effective_rate_bps: number; stablecoin_discount_bps: number; expires_after_months: number | null; contact_sales: boolean; enabled: boolean }

/** Canonical fee model (docs/03-fees-and-credits.md): 1 credit = $0.01; 30 bps nominal, floor 2, cap 2000. */
export const FEE_BPS = 30;
export const FEE_FLOOR = 2;
export const FEE_CAP = 2000;
/** Test mode never runs out of credits: when a new invoice needs more than is available, this many are added. */
export const TEST_MODE_TOPUP = 10000;
export const STABLECOIN_DISCOUNT_BPS = 300;
export const STABLECOINS = new Set(["usdc", "usdt", "dai"]);
export function creditsForUsd(fiatUsd: number): number {
  return Math.min(Math.max(Math.round((fiatUsd * FEE_BPS) / 10000 / 0.01), FEE_FLOOR), FEE_CAP);
}

export interface LedgerEntry { id: string; object: "credit_ledger_entry"; livemode: false; type: "debit" | "credit"; reason: string; amount: number; balance_after: number; related_object: { id: string; object: string } | null; description: string | null; created_at: string }

export class Store {
  invoices = new Map<string, Invoice>();
  payments = new Map<string, Payment>();
  webhooks = new Map<string, Webhook>();
  deliveries = new Map<string, Delivery>();
  events = new Map<string, Event>();
  checkoutSessions = new Map<string, CheckoutSession>();
  purchases = new Map<string, CreditPurchase>();
  ledger: LedgerEntry[] = [];
  records: AccountingRecord[] = [];
  recordKeys = new Set<string>();
  exports = new Map<string, ExportObject>();
  exportFiles = new Map<string, Buffer>();
  idempotency = new Map<string, { status: number; body: unknown }>();
  /** Credits held (never negative). What is reserved and available is derived from open invoices, see reservedCredits(). */
  credits = { balance: 1000 };
  /** Estimated fee reserved per open invoice paid with credits (invoice id -> credits). */
  reservations = new Map<string, number>();

  bundles: Bundle[] = [
    { id: "bnd_starter_2500", object: "credit_bundle", name: "Starter", description: "Small stores", credits: 2500, bonus_credits: 0, monthly: false, price: { amount: "25.00", currency: "USD" }, price_per_credit: "0.0100", effective_rate_bps: 30, stablecoin_discount_bps: STABLECOIN_DISCOUNT_BPS, expires_after_months: 24, contact_sales: false, enabled: true },
    { id: "bnd_growth_15000", object: "credit_bundle", name: "Growth", description: "Established SMB", credits: 15000, bonus_credits: 0, monthly: false, price: { amount: "120.00", currency: "USD" }, price_per_credit: "0.0080", effective_rate_bps: 24, stablecoin_discount_bps: STABLECOIN_DISCOUNT_BPS, expires_after_months: 24, contact_sales: false, enabled: true },
    { id: "bnd_scale_75000", object: "credit_bundle", name: "Scale", description: "Mid-market", credits: 75000, bonus_credits: 0, monthly: false, price: { amount: "450.00", currency: "USD" }, price_per_credit: "0.0060", effective_rate_bps: 18, stablecoin_discount_bps: STABLECOIN_DISCOUNT_BPS, expires_after_months: 24, contact_sales: false, enabled: true },
    { id: "bnd_volume_400000", object: "credit_bundle", name: "Volume", description: "High volume", credits: 400000, bonus_credits: 0, monthly: false, price: { amount: "1600.00", currency: "USD" }, price_per_credit: "0.0040", effective_rate_bps: 12, stablecoin_discount_bps: STABLECOIN_DISCOUNT_BPS, expires_after_months: 24, contact_sales: false, enabled: true },
    { id: "bnd_enterprise", object: "credit_bundle", name: "Enterprise", description: "2,000,000+ credits, negotiated; SLA, dedicated watchers", credits: 2000000, bonus_credits: 0, monthly: false, price: { amount: "6000.00", currency: "USD" }, price_per_credit: "0.0030", effective_rate_bps: 9, stablecoin_discount_bps: STABLECOIN_DISCOUNT_BPS, expires_after_months: 24, contact_sales: true, enabled: true },
  ];

  // Merchant wallets (test mode: one per chain, pre-registered so the mock works out of the box)
  wallets = new Map<string, { id: string; chain: Chain; type: "xpub" | "address"; address?: string; nextIndex: number; assets: string[]; label: string }>();
  // Operator wallets receiving credit purchases
  operatorWallets = new Map<string, { id: string; chain: Chain; type: "xpub" | "address"; address?: string; nextIndex: number; assets: string[]; label: string }>();

  constructor() {
    const chains = new Set(ASSETS.map((a) => a.chain));
    for (const chain of chains) {
      const assets = ASSETS.filter((a) => a.chain === chain).map((a) => a.id);
      const isUtxo = chain === "bitcoin";
      const wid = `wal_${chain}_mock`;
      this.wallets.set(wid, { id: wid, chain, type: isUtxo ? "xpub" : "address", address: isUtxo ? undefined : fakeAddress(chain), nextIndex: 0, assets, label: `Mock ${chain} wallet` });
      const oid = `opw_${chain}_mock`;
      // Credits are bought in native coins and USDC/USDT/DAI, not every token a merchant may accept.
      const opsAssets = ASSETS.filter((a) => a.chain === chain && (a.kind === "native" || STABLECOINS.has(a.symbol.toLowerCase()))).map((a) => a.id);
      this.operatorWallets.set(oid, { id: oid, chain, type: isUtxo ? "xpub" : "address", address: isUtxo ? undefined : fakeAddress(chain), nextIndex: 0, assets: opsAssets, label: `Ops ${chain}` });
    }
  }

  deriveAddress(w: { chain: Chain; type: "xpub" | "address"; address?: string; nextIndex: number }): { address: string; derivation_path: string | null } {
    if (w.type === "address") return { address: w.address!, derivation_path: null };
    const idx = w.nextIndex++;
    const coin = w.chain === "bitcoin" ? "1'" : "1'"; // testnet coin type
    return { address: fakeAddress(w.chain, idx), derivation_path: `m/84'/${coin}/0'/0/${idx}` };
  }

  buildPaymentOptions(amount: string, currency: string, assetIds: string[], wallets: Map<string, { id: string; chain: Chain; type: "xpub" | "address"; address?: string; nextIndex: number; assets: string[] }>, label?: string, overrides: Record<string, number> = {}): { options: PaymentOption[]; rates: Record<string, string> } {
    const options: PaymentOption[] = [];
    const rates: Record<string, string> = {};
    for (const aid of assetIds) {
      const asset = ASSETS.find((a) => a.id === aid);
      if (!asset) continue;
      const wallet = [...wallets.values()].find((w) => w.assets.includes(aid));
      if (!wallet) continue;
      const { address, derivation_path } = this.deriveAddress(wallet);
      let amt: { amount: string; amount_minor: string; rate: string };
      if (currency.includes(":")) {
        // crypto-priced: same asset only
        if (currency !== aid) continue;
        const minor = toMinor(amount, asset.decimals);
        amt = { amount: fromMinor(minor, asset.decimals), amount_minor: minor.toString(), rate: "1" };
      } else {
        amt = fiatToAsset(amount, currency, asset);
      }
      rates[aid] = amt.rate;
      const uri = paymentUri(asset, address, amt.amount, amt.amount_minor, label);
      options.push({
        asset: aid, symbol: asset.symbol, chain: asset.chain, network_id: asset.network_id, wallet_id: wallet.id, address, derivation_path,
        contract_address: asset.contract_address, decimals: asset.decimals, amount: amt.amount, amount_minor: amt.amount_minor, rate: amt.rate,
        ...uri, required_confirmations: overrides[aid] ?? asset.required_confirmations, status: "available",
      });
    }
    return { options, rates };
  }

  addLedger(type: "debit" | "credit", reason: string, amount: number, related: { id: string; object: string } | null, description: string | null): LedgerEntry {
    // The balance never goes below zero: callers cap debits at what is held.
    this.credits.balance = Math.max(0, this.credits.balance + (type === "credit" ? amount : -amount));
    const e: LedgerEntry = { id: id("led"), object: "credit_ledger_entry", livemode: false, type, reason, amount, balance_after: this.credits.balance, related_object: related, description, created_at: now() };
    this.ledger.unshift(e);
    return e;
  }

  /** Estimated fees of open invoices paid with credits; released once the invoice is paid (fee charged), expires or is cancelled. */
  reservedCredits(): number {
    let n = 0;
    for (const [invId, credits] of this.reservations) {
      const inv = this.invoices.get(invId);
      if (inv && !inv.fee && ["new", "pending", "confirming"].includes(inv.status)) n += credits;
    }
    return Math.min(n, this.credits.balance);
  }
}

// ----------------------------------------------------------------- webhook signing
export function signPayload(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export function newSecret(): string {
  return "whsec_" + randomBytes(32).toString("hex");
}

/** Newest first by `sortKey` (`created_at` unless given), cursor = base64url of the last id. */
export function paginate<T extends { id: string }>(items: T[], query: Record<string, unknown>, sortKey: (item: T) => string = (i) => (i as unknown as { created_at: string }).created_at) {
  const limit = Math.min(Math.max(Number(query.limit) || 20, 1), 100);
  const sorted = [...items].sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : a.id < b.id ? 1 : -1));
  let start = 0;
  if (typeof query.cursor === "string" && query.cursor) {
    const idx = sorted.findIndex((i) => i.id === Buffer.from(query.cursor as string, "base64url").toString());
    start = idx >= 0 ? idx + 1 : 0;
  }
  const page = sorted.slice(start, start + limit);
  const has_more = start + limit < sorted.length;
  return { object: "list" as const, data: page, has_more, next_cursor: has_more ? Buffer.from(page[page.length - 1].id).toString("base64url") : null };
}
