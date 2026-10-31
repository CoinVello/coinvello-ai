/**
 * CoinVello API types. Mirrors api/openapi.yaml (version 2026-10-01).
 * Amounts are decimal strings; never parse them as floats.
 */

export type DecimalString = string;
export type AssetId = string; // "<asset>:<chain>", e.g. "btc:bitcoin"
export type Chain =
  | "bitcoin" | "ethereum" | "base" | "arbitrum" | "optimism"
  | "polygon" | "bnb" | "avalanche" | "robinhood" | "solana" | "tron";

export type Metadata = Record<string, string>;

export interface ListResponse<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ListParams {
  limit?: number;
  cursor?: string;
  created_gte?: string;
  created_lte?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface RequestOptions {
  idempotencyKey?: string;
  apiVersion?: string;
  timeoutMs?: number;
}

// ----------------------------------------------------------------- invoices
export type InvoiceStatus =
  | "new" | "pending" | "confirming" | "paid" | "underpaid" | "overpaid"
  | "expired" | "cancelled" | "refund_requested";

export interface Customer { email?: string; name?: string; reference?: string }

export interface PaymentOption {
  asset: AssetId;
  symbol: string;
  chain: Chain;
  network_id: string | null;
  wallet_id: string;
  address: string;
  derivation_path: string | null;
  contract_address: string | null;
  decimals: number;
  amount: DecimalString;
  amount_minor: string;
  rate: DecimalString;
  payment_uri: string;
  qr_payload: string;
  memo: string | null;
  required_confirmations: number;
  status: "available" | "selected" | "paid" | "unavailable";
}

export interface InvoicePaidSummary {
  asset: AssetId | null;
  amount_received: DecimalString;
  amount_received_fiat: DecimalString;
  amount_due: DecimalString;
  amount_remaining: DecimalString;
  confirmations: number;
  required_confirmations: number;
  payment_ids: string[];
}

export interface Invoice {
  id: string;
  object: "invoice";
  livemode: boolean;
  status: InvoiceStatus;
  amount: DecimalString;
  currency: string;
  pricing: "fiat" | "crypto";
  accepted_assets: AssetId[];
  payment_options: PaymentOption[];
  paid: InvoicePaidSummary | null;
  order_id: string | null;
  description: string | null;
  customer?: Customer;
  success_url: string | null;
  cancel_url: string | null;
  hosted_url: string;
  refund_claim_url: string | null;
  rate_lock?: { id: string | null; locked: boolean; locked_until: string | null; rates: Record<AssetId, DecimalString> };
  required_confirmations?: Record<AssetId, number>;
  underpayment_tolerance?: DecimalString;
  overpayment_tolerance?: DecimalString;
  checkout_session_id: string | null;
  fee?: { credits: number; bps: number; fiat_value_usd: DecimalString; ledger_entry_id: string | null } | null;
  tax?: InvoiceTax | null;
  metadata?: Metadata;
  expires_at: string;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceCreateParams {
  amount: DecimalString;
  currency: string;
  accepted_assets?: AssetId[];
  order_id?: string;
  description?: string;
  customer?: Customer;
  success_url?: string;
  cancel_url?: string;
  expires_in?: number;
  rate_lock?: boolean;
  rate_lock_id?: string;
  required_confirmations?: Record<AssetId, number>;
  underpayment_tolerance?: DecimalString;
  overpayment_tolerance?: DecimalString;
  payment_options_mode?: "all" | "single";
  /** The tax portion of the sale, included in `amount`; copied to the invoice's records and exports. */
  tax?: InvoiceTax;
  metadata?: Metadata;
}

export interface InvoiceUpdateParams {
  description?: string;
  metadata?: Metadata;
  success_url?: string;
  cancel_url?: string;
}

// ----------------------------------------------------------------- payments
export type PaymentStatus = "detected" | "confirming" | "confirmed" | "failed";

export interface Payment {
  id: string;
  object: "payment";
  livemode: boolean;
  invoice_id: string;
  asset: AssetId;
  chain: Chain;
  tx_hash: string;
  tx_index: number | null;
  from_address: string | null;
  to_address: string;
  amount: DecimalString;
  amount_minor: string;
  amount_fiat: DecimalString;
  status: PaymentStatus;
  confirmations: number;
  required_confirmations: number;
  block_height: number | null;
  block_hash: string | null;
  simulated?: boolean;
  detected_at: string;
  confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ----------------------------------------------------------------- wallets
/** `active` by default; `verified` after the optional ownership proof; `unverified` is a legacy synonym of `active`. */
export type WalletStatus = "active" | "verified" | "archived" | "unverified";

export interface Wallet {
  id: string;
  object: "wallet";
  livemode: boolean;
  type: "xpub" | "address";
  chain: Chain;
  label: string;
  status: WalletStatus;
  assets: AssetId[];
  enabled: boolean;
  xpub: string | null;
  derivation_path: string | null;
  address_type: string | null;
  next_index: number | null;
  address: string | null;
  /** xpub wallets: the first derived address, to compare with the wallet's first receive address. */
  first_address?: string | null;
  /** Optional ownership proof; never required. */
  verification: { status: "not_required" | "pending" | "verified" | "unverified"; signing_address: string | null; verified_at: string | null };
  metadata?: Metadata;
  created_at: string;
  updated_at: string;
}

export interface WalletCreateParams {
  type: "xpub" | "address";
  /** One of `chain` or `chains`. */
  chain?: Chain;
  /** `type: address` only: register the same EVM address on each chain as one group (`group_id`). */
  chains?: Chain[];
  label: string;
  xpub?: string;
  derivation_path?: string;
  address_type?: "p2pkh" | "p2sh-p2wpkh" | "p2wpkh" | "p2tr";
  start_index?: number;
  address?: string;
  assets?: AssetId[];
  enabled?: boolean;
  metadata?: Metadata;
}

export interface WalletVerificationChallenge {
  id: string;
  object: "wallet_verification_challenge";
  wallet_id: string;
  message: string;
  signing_address: string;
  scheme: "bip137" | "eip191" | "ed25519" | "tip191";
  expires_at: string;
}

// ----------------------------------------------------------------- webhooks
export type EventType =
  | "invoice.created" | "invoice.pending" | "invoice.confirming" | "invoice.paid"
  | "invoice.underpaid" | "invoice.overpaid" | "invoice.expired" | "invoice.cancelled"
  | "invoice.refund_requested"
  | "payment.detected" | "payment.confirmed" | "payment.failed"
  | "wallet.verified"
  | "conversion.completed" | "conversion.failed"
  | "offramp.completed" | "offramp.failed"
  | "refund.completed" | "refund.failed"
  | "credits.low" | "credits.added"
  | "credits.purchase.paid" | "credits.purchase.underpaid" | "credits.purchase.expired"
  | "checkout_session.completed" | "checkout_session.expired";

export interface Webhook {
  id: string;
  object: "webhook";
  livemode: boolean;
  url: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  secret?: string; // only on create / rotate
  api_version: string;
  status?: "active" | "degraded" | "disabled";
  created_at: string;
  updated_at: string;
}

export interface WebhookCreateParams {
  url: string;
  events: (EventType | "*")[];
  description?: string;
  api_version?: string;
  enabled?: boolean;
  metadata?: Metadata;
}

export interface WebhookDelivery {
  id: string;
  object: "webhook_delivery";
  webhook_id: string;
  event_id: string;
  event_type: string;
  attempt: number;
  status: "pending" | "succeeded" | "failed" | "exhausted";
  response_status: number | null;
  next_retry_at: string | null;
  created_at: string;
}

// ----------------------------------------------------------------- events
export interface Event<T = Record<string, unknown>> {
  id: string;
  object: "event";
  type: EventType | string;
  livemode: boolean;
  api_version: string;
  created_at: string;
  data: { object: T; previous_attributes?: Record<string, unknown>; invoice_status?: InvoiceStatus; [k: string]: unknown };
  request?: { id: string | null; idempotency_key: string | null };
  pending_webhooks?: number;
}

// ----------------------------------------------------------------- credits
export interface CreditsBalance {
  object: "credits_balance";
  livemode: boolean;
  /** Credits the account holds: available + reserved. Never negative. */
  balance: number;
  /** Credits free to spend: balance minus reserved. A new invoice paid with credits needs its estimated fee available. */
  available: number;
  /** Estimated fees of open invoices paid with credits. */
  reserved: number;
  expiring_soon?: { credits: number; before: string };
  low_balance_threshold: number;
  estimated_payments_remaining?: number;
  /** @deprecated alias of estimated_payments_remaining */
  estimated_invoices_remaining?: number;
  auto_topup?: AutoTopup;
  updated_at: string;
}

export interface AutoTopup {
  enabled: boolean;
  bundle_id?: string;
  trigger_below?: number;
  /** Saved card (`pm_`) to charge; null = the default card. */
  payment_method?: string | null;
  /** USD cap on automatic charges per calendar month (UTC); null = no cap. */
  monthly_limit?: DecimalString | null;
  readonly spent_this_month?: DecimalString;
  readonly consecutive_failures?: number;
  readonly last_attempt_at?: string | null;
  readonly disabled_reason?: "card_declined" | "payment_method_removed" | "disputed" | null;
}

export interface AutoTopupParams {
  enabled: boolean;
  bundle_id?: string;
  trigger_below?: number;
  payment_method?: string | null;
  monthly_limit?: DecimalString | null;
}

/** A saved card for buying credits (processed by Square; only brand, last four and expiry are kept). */
export interface PaymentMethod {
  id: string;
  object: "payment_method";
  livemode: boolean;
  type: "card";
  brand: string;
  last4: string;
  exp: string | null;
  is_default: boolean;
  status?: "active" | "removed";
  created_at: string;
}

export interface PaymentMethodList {
  object: "list";
  data: PaymentMethod[];
  has_more: boolean;
  next_cursor: string | null;
  card_payments_available: boolean;
  card_form: { provider: "square"; environment: "sandbox" | "production"; application_id: string; location_id: string; script_url: string } | null;
}

export interface CreditBundle {
  id: string;
  object: "credit_bundle";
  name: string;
  description?: string | null;
  credits: number;
  bonus_credits: number;
  monthly?: boolean;
  price: { amount: DecimalString; currency: "USD" };
  price_per_credit: DecimalString | null;
  effective_rate_bps?: number;
  stablecoin_discount_bps?: number;
  expires_after_months?: number | null;
  contact_sales?: boolean;
  crypto_prices?: { asset: AssetId; amount: DecimalString; rate: DecimalString; discount_applied?: boolean }[];
  rates_as_of?: string;
}

export interface CreditPurchasePayment {
  status: InvoiceStatus;
  amount: DecimalString;
  currency: "USD";
  payment_options: PaymentOption[];
  rate_locked_until: string;
  paid: InvoicePaidSummary | null;
  payment_ids: string[];
  expires_at: string;
  paid_at: string | null;
}

export interface CreditPurchase {
  id: string;
  object: "credit_purchase";
  livemode: boolean;
  status: CreditPurchaseStatus;
  method: "crypto" | "card";
  bundle_id: string;
  credits: number;
  price: { amount: DecimalString; currency: "USD" };
  /** Crypto purchases only; null for card purchases. */
  payment: CreditPurchasePayment | null;
  /** Card purchases only. */
  card?: { payment_method: string; brand: string; last4: string; auto_topup: boolean } | null;
  failure?: { code: string; message: string } | null;
  checkout_url: string | null;
  credits_added_at: string | null;
  ledger_entry_id: string | null;
  metadata?: Metadata;
  created_at: string;
  updated_at: string;
}

export type CreditPurchaseStatus = InvoiceStatus | "failed" | "refunded" | "disputed";

export interface CreditPurchaseCreateParams {
  bundle_id: string;
  pay_asset?: string;
  pay_chain?: Chain;
  /** Pay with this saved card (`pm_`) instead of crypto; not combinable with pay_asset/pay_chain. */
  payment_method?: string;
  expires_in?: number;
  metadata?: Metadata;
}

export interface CreditLedgerEntry {
  id: string;
  object: "credit_ledger_entry";
  livemode: boolean;
  type: "debit" | "credit";
  reason: string;
  amount: number;
  balance_after: number;
  related_object?: { id: string; object: string };
  description: string | null;
  created_at: string;
}

// ----------------------------------------------------------------- rates
export interface RateQuote {
  id: string;
  object: "rate_quote";
  from: string;
  to: string;
  from_amount: DecimalString;
  to_amount: DecimalString;
  rate: DecimalString;
  expires_at: string;
}

export interface RateLock {
  id: string;
  object: "rate_lock";
  quote_id: string;
  rate: DecimalString;
  status: "active" | "used" | "expired";
  locked_until: string;
}

// ----------------------------------------------------------------- signing
export interface UnsignedTransaction {
  step: number;
  purpose: "approve" | "swap" | "deposit" | "refund" | "bridge";
  chain: Chain;
  format: "eip1559" | "legacy" | "psbt_base64" | "solana_message_base64" | "tron_raw_hex";
  from: string;
  payload: Record<string, unknown>;
  human_readable?: { summary: string; to_label?: string };
  expires_at: string | null;
}

export interface SignedSubmission {
  signed_transactions?: { step: number; signed: string }[];
  tx_hashes?: { step: number; tx_hash: string }[];
}

export interface Conversion {
  id: string;
  object: "conversion";
  status: "awaiting_signature" | "submitted" | "pending" | "completed" | "failed" | "expired" | "cancelled";
  from_asset: AssetId;
  to_asset: AssetId;
  from_amount: DecimalString;
  to_amount_expected: DecimalString;
  to_amount_min: DecimalString;
  to_amount_received: DecimalString | null;
  unsigned_transactions: UnsignedTransaction[];
  signature_deadline: string;
  created_at: string;
  [k: string]: unknown;
}

export interface Refund {
  id: string;
  object: "refund";
  status: "requested" | "awaiting_destination" | "awaiting_signature" | "submitted" | "processing" | "completed" | "failed" | "cancelled";
  invoice_id: string;
  payment_id: string | null;
  asset: AssetId;
  amount: DecimalString;
  destination_address: string | null;
  unsigned_transaction: UnsignedTransaction | null;
  tx_hash: string | null;
  created_at: string;
  [k: string]: unknown;
}

export interface RefundCreateParams {
  invoice_id?: string;
  payment_id?: string;
  amount?: DecimalString;
  destination_address?: string;
  deduct_network_fee?: boolean;
  reason?: string;
  note?: string;
  metadata?: Metadata;
}

// ----------------------------------------------------------------- checkout
export interface CheckoutSession {
  id: string;
  object: "checkout_session";
  livemode: boolean;
  status: "open" | "complete" | "expired";
  url: string;
  invoice_id: string;
  invoice?: Invoice | null;
  invoice_status: InvoiceStatus;
  amount: DecimalString;
  currency: string;
  order_id: string | null;
  success_url: string;
  cancel_url: string | null;
  expires_at: string;
  created_at: string;
}

export interface CheckoutSessionCreateParams extends InvoiceCreateParams {
  success_url: string;
  line_items?: { name: string; description?: string; quantity: number; unit_amount: DecimalString; image_url?: string }[];
  redirect_on?: "confirming" | "paid";
  locale?: string;
  branding?: { theme?: "light" | "dark" | "auto"; logo_url?: string; primary_color?: string; merchant_name?: string };
  collect_email?: boolean;
  allow_asset_change?: boolean;
}

// ----------------------------------------------------------------- testing
export interface SimulatePaymentParams {
  invoice_id: string;
  asset?: AssetId;
  amount?: DecimalString;
  confirmations?: number;
  tx_hash?: string;
  from_address?: string;
  delay_seconds?: number;
}

// ----------------------------------------------------------------- records & exports (bookkeeping, tax)
/** In the invoice currency and included in the invoice `amount`. `jurisdiction` is a region code you choose (`DE`, `US-CA`), never anything about the payer. */
export interface InvoiceTax { amount: DecimalString; rate?: DecimalString | null; label?: string | null; jurisdiction?: string | null }

export type RecordType =
  | "payment_received" | "payment_reversed" | "refund_sent" | "fee_prepaid" | "fee_onchain"
  | "credit_purchase" | "credit_adjustment" | "conversion" | "offramp_payout";
export type RecordFlag = "overpaid" | "underpaid" | "late" | "reversal" | "non_cash" | "simulated" | "backfilled";

export interface RecordLeg {
  /** Asset id (`usdc:polygon`), or an ISO 4217 code for a fiat leg. */
  asset: string;
  amount: DecimalString;
  amount_minor?: string | null;
}

/** A fiat valuation with the rate that produced it and where the rate came from. */
export interface RecordValue {
  currency: string;
  amount: DecimalString;
  rate?: DecimalString | null;
  rate_as_of?: string | null;
  source?: {
    provider: "coinvello_oracle" | "invoice_rate_lock" | "credits_nominal" | "card_processor" | "offramp_partner" | "ecb_reference";
    method?: string | null;
    venues?: string[];
    snapshot_id?: string | null;
  };
}

export interface RecordInvoiceSnapshot {
  id: string;
  status: InvoiceStatus;
  order_id: string | null;
  description: string | null;
  amount: DecimalString;
  currency: string;
  pricing: "fiat" | "crypto";
  checkout_session_id: string | null;
  /** The invoice's `customer.reference`. No payer email or name is ever copied. */
  customer_reference: string | null;
}

/** One immutable row of the book of record. */
export interface AccountingRecord {
  id: string;
  object: "record";
  livemode: boolean;
  type: RecordType;
  /** Block time of the transaction (ledger time for credit movements); reports and exports bucket by this. */
  occurred_at: string;
  recorded_at: string;
  description?: string;
  received?: RecordLeg | null;
  sent?: RecordLeg | null;
  /** Network fee you paid, if any. */
  fee?: RecordLeg | null;
  chain?: Chain | null;
  tx_hash?: string | null;
  tx_index?: number | null;
  block_height?: number | null;
  from_address?: string | null;
  to_address?: string | null;
  derivation_path?: string | null;
  explorer_url?: string | null;
  /** What the customer owed in the invoice currency at the locked rate; null when no fiat amount was agreed. */
  contract_value?: RecordValue | null;
  /** Market value at `occurred_at` in the reporting currency. */
  value: RecordValue;
  /** `value` in USD, so every export shares one column whatever the reporting currency. */
  value_usd: DecimalString;
  tax?: InvoiceTax | null;
  credits?: number | null;
  invoice?: RecordInvoiceSnapshot | null;
  related?: Record<string, unknown>;
  reverses_record_id?: string | null;
  flags: RecordFlag[];
  simulated: boolean;
  metadata?: Metadata;
}

export interface RecordListParams extends ListParams {
  type?: RecordType;
  /** Records whose received, sent or fee leg is this asset. */
  asset?: AssetId;
  chain?: Chain;
  invoice_id?: string;
  order_id?: string;
  tx_hash?: string;
  occurred_gte?: string;
  occurred_lte?: string;
  /** Re-value `value` into this currency from `value_usd` at the historical rate. */
  currency?: string;
  /** Test mode only: include rows created by `/test/simulate_*`. */
  include_simulated?: boolean;
}

export interface RecordsSummaryParams {
  /** Inclusive, in `timezone`: a date (`2026-01-01`) or a date-time. */
  period_start: string;
  /** Exclusive. */
  period_end: string;
  currency?: string;
  /** IANA zone used to bucket `occurred_at`. */
  timezone?: string;
  group_by?: "month" | "asset" | "chain" | "type" | "address";
  include_simulated?: boolean;
}

export interface RecordsTotals {
  payments_count: number;
  invoices_paid: number;
  refunds_count: number;
  sales: DecimalString;
  tax_collected: DecimalString;
  received_market_value: DecimalString;
  valuation_difference: DecimalString;
  refunds: DecimalString;
  fees_prepaid: DecimalString;
  credits_consumed: number;
  fees_onchain: DecimalString;
  network_fees: DecimalString;
  credit_purchases: DecimalString;
  net_received: DecimalString;
}

export interface RecordsSummary extends RecordsTotals {
  object: "records_summary";
  livemode: boolean;
  period: { start: string; end: string };
  currency: string;
  timezone: string;
  group_by?: RecordsSummaryParams["group_by"] | null;
  groups?: (RecordsTotals & { key: string })[];
}

export type ExportDataset =
  | "records" | "invoices" | "payments" | "refunds" | "sweeps" | "credit_ledger"
  | "credit_purchases" | "conversions" | "offramp_payouts" | "all";
export type ExportFormat = "csv" | "xlsx" | "json";
/** Column layout for the `records` dataset; every preset but `generic` is CSV only. */
export type ExportPreset = "generic" | "journal" | "quickbooks" | "xero" | "koinly" | "cointracker" | "coinledger";
export type ExportStatus = "queued" | "processing" | "ready" | "failed" | "expired";
/** `start` inclusive, `end` exclusive, in the export's timezone; a date (`2026-01-01`) or a date-time. */
export interface ExportPeriod { start: string; end: string }

export interface ExportCreateParams {
  dataset?: ExportDataset;
  format: ExportFormat;
  preset?: ExportPreset;
  /** Omit or pass `null` for the entire history. */
  period?: ExportPeriod | null;
  timezone?: string;
  currency?: string;
  /** Test mode only: include rows created by `/test/simulate_*`. */
  include_simulated?: boolean;
  metadata?: Metadata;
}

export interface Export {
  id: string;
  object: "export";
  livemode: boolean;
  status: ExportStatus;
  dataset: ExportDataset;
  format: ExportFormat;
  preset: ExportPreset;
  period: ExportPeriod | null;
  timezone: string;
  currency: string;
  include_simulated?: boolean;
  rows?: number | null;
  /** Set when `ready`; verify a download against `sha256`. */
  file?: { name: string; content_type: string; bytes: number; sha256: string } | null;
  /** Signed URL, valid until `download_expires_at` (files are kept 7 days). */
  download_url?: string | null;
  download_expires_at?: string | null;
  failure_reason?: string | null;
  metadata?: Metadata;
  created_at: string;
  completed_at?: string | null;
}

/** How records are valued and bucketed for this account. */
export interface RecordsSettings {
  reporting_currency: string;
  /** `MM-DD` of the first day of the fiscal year. */
  fiscal_year_start: string;
  /** IANA zone used to bucket `occurred_at` into days, months and fiscal years. */
  timezone: string;
}

// ------------------------------------------------------------ pay as you go
export type BillingPlan = "prepaid" | "pay_as_you_go";

export interface Receiver {
  id: string;
  object: "receiver";
  livemode: boolean;
  chain: Chain;
  wallet_id: string;
  address: string;
  wallet_address: string;
  fee_bps: number;
  fee_recipient: string;
  fee_recipient_backup: string;
  contract: { kind: "evm_factory" | "tron_factory" | "solana_program"; address: string; version: string };
  deployed: boolean;
  deployed_at: string | null;
  status: "active" | "sweep_only" | "retired";
  unswept: { asset: string; amount: string; to_wallet: string; fee: string }[];
  next_sweep: { status: "nothing_to_sweep" | "waiting_for_balance" | "scheduled" | "gas_too_high"; estimated_at: string | null; balance_needed_usd: string | null };
  last_swept_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Sweep {
  id: string;
  object: "sweep";
  livemode: boolean;
  receiver_id: string;
  chain: Chain;
  asset: string;
  amount: string;
  to_wallet: string;
  fee: string;
  fee_destination: "primary" | "backup" | "forfeited";
  initiated_by: "coinvello" | "merchant" | "third_party";
  network_fee: { amount: string; asset: string } | null;
  includes_deployment: boolean;
  tx_hash: string | null;
  block_height: number | null;
  invoice_ids: string[];
  status: "pending" | "confirmed" | "failed";
  failure_reason: string | null;
  simulated: boolean;
  created_at: string;
  confirmed_at: string | null;
}

export interface SweepTransaction { object: "sweep_transaction"; receiver_id: string; transactions: UnsignedTransaction[] }
