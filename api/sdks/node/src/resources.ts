import type { HttpClient } from "./http.js";
import * as webhooks from "./webhooks.js";
import type { AccountingRecord, AutoTopupParams, Chain, PaymentMethodList, Export, ExportCreateParams, ExportDataset, ExportStatus,
  RecordListParams, RecordsSettings, RecordsSummary, RecordsSummaryParams,
  CheckoutSession, CheckoutSessionCreateParams, Conversion, CreditBundle, CreditLedgerEntry,
  CreditPurchase, CreditPurchaseCreateParams, CreditsBalance, Event, Invoice, InvoiceCreateParams,
  InvoiceUpdateParams, ListParams, Payment, RateLock, RateQuote, Refund, RefundCreateParams,
  Receiver, RequestOptions, SignedSubmission, SimulatePaymentParams, Sweep, SweepTransaction, Wallet, WalletCreateParams,
  WalletVerificationChallenge, Webhook, WebhookCreateParams, WebhookDelivery,
} from "./types.js";

export class Invoices {
  constructor(private readonly http: HttpClient) {}
  create(params: InvoiceCreateParams, opts?: RequestOptions) { return this.http.post<Invoice>("/invoices", params, opts); }
  get(id: string) { return this.http.get<Invoice>(`/invoices/${id}`); }
  list(params?: ListParams & { status?: string; order_id?: string; customer_email?: string }) { return this.http.list<Invoice>("/invoices", params); }
  update(id: string, params: InvoiceUpdateParams) { return this.http.patch<Invoice>(`/invoices/${id}`, params); }
  cancel(id: string, opts?: RequestOptions) { return this.http.post<Invoice>(`/invoices/${id}/cancel`, {}, opts); }
  expire(id: string, opts?: RequestOptions) { return this.http.post<Invoice>(`/invoices/${id}/expire`, {}, opts); }
  listPayments(id: string, params?: ListParams) { return this.http.list<Payment>(`/invoices/${id}/payments`, params); }
}

export class Payments {
  constructor(private readonly http: HttpClient) {}
  get(id: string) { return this.http.get<Payment>(`/payments/${id}`); }
  list(params?: ListParams & { invoice_id?: string; status?: string; chain?: string; tx_hash?: string }) { return this.http.list<Payment>("/payments", params); }
}

export class Wallets {
  constructor(private readonly http: HttpClient) {}
  create(params: WalletCreateParams & { chain: Chain }, opts?: RequestOptions) { return this.http.post<Wallet>("/wallets", params, opts); }
  /** Extend an EVM address wallet to more chains (siblings join its group). */
  addChains(id: string, params: { chains: Chain[]; assets?: string[] }, opts?: RequestOptions) { return this.http.post<{ object: "list"; data: Wallet[]; group_id: string }>(`/wallets/${id}/chains`, params, opts); }
  /** Register one EVM address on several chains as a group; returns the created wallets. */
  createGroup(params: WalletCreateParams & { chains: Chain[]; type: "address" }, opts?: RequestOptions) { return this.http.post<{ object: "list"; data: Wallet[]; group_id: string }>("/wallets", params, opts); }
  get(id: string) { return this.http.get<Wallet>(`/wallets/${id}`); }
  list(params?: ListParams & { chain?: string; status?: string; group_id?: string }) { return this.http.list<Wallet>("/wallets", params); }
  update(id: string, params: Partial<Pick<WalletCreateParams, "label" | "assets" | "enabled" | "metadata">>) { return this.http.patch<Wallet>(`/wallets/${id}`, params); }
  archive(id: string) { return this.http.delete<Wallet>(`/wallets/${id}`); }
  createVerification(id: string) { return this.http.post<WalletVerificationChallenge>(`/wallets/${id}/verification`); }
  verify(id: string, signature: string, challengeId?: string) { return this.http.post<Wallet>(`/wallets/${id}/verify`, { signature, challenge_id: challengeId }); }
  listAddresses(id: string, params?: ListParams) { return this.http.list<{ address: string; derivation_path: string; index: number; invoice_id: string | null }>(`/wallets/${id}/addresses`, params); }
}

export class WebhooksResource {
  constructor(private readonly http: HttpClient) {}
  create(params: WebhookCreateParams, opts?: RequestOptions) { return this.http.post<Webhook>("/webhooks", params, opts); }
  get(id: string) { return this.http.get<Webhook>(`/webhooks/${id}`); }
  list(params?: ListParams) { return this.http.list<Webhook>("/webhooks", params); }
  update(id: string, params: Partial<WebhookCreateParams>) { return this.http.patch<Webhook>(`/webhooks/${id}`, params); }
  delete(id: string) { return this.http.delete<{ id: string; object: "webhook"; deleted: true }>(`/webhooks/${id}`); }
  rotateSecret(id: string, gracePeriodSeconds?: number) { return this.http.post<Webhook>(`/webhooks/${id}/rotate_secret`, { grace_period_seconds: gracePeriodSeconds }); }
  test(id: string, eventType = "ping") { return this.http.post<WebhookDelivery>(`/webhooks/${id}/test`, { event_type: eventType }); }
  listDeliveries(id: string, params?: ListParams & { status?: string; event_id?: string }) { return this.http.list<WebhookDelivery>(`/webhooks/${id}/deliveries`, params); }
  retryDelivery(id: string, deliveryId: string) { return this.http.post<WebhookDelivery>(`/webhooks/${id}/deliveries/${deliveryId}/retry`); }
  /** Re-deliver every subscribed event created in [since, until] (max 1,000 per call). */
  replay(id: string, params: { since: string; until?: string; types?: string[] }, opts?: RequestOptions) {
    return this.http.post<{ object: "webhook_replay"; webhook_id: string; since: string; until: string; types: string[] | null; events_matched: number; deliveries_enqueued: number; truncated: boolean; oldest_event_id: string | null; newest_event_id: string | null }>(`/webhooks/${id}/replay`, params, opts);
  }

  /** Verify a signed delivery and parse the event. Throws SignatureVerificationError. */
  constructEvent<T = Record<string, unknown>>(rawBody: string | Buffer, header: string | undefined | null, secret: string, tolerance?: number): Event<T> {
    return webhooks.constructEvent<T>(rawBody, header, secret, tolerance);
  }
  /** Produce a `CoinVello-Signature` header (for tests). */
  sign(rawBody: string | Buffer, secret: string, timestamp?: number) { return webhooks.signPayload(rawBody, secret, timestamp); }
}

export class Credits {
  constructor(private readonly http: HttpClient) {}
  balance() { return this.http.get<CreditsBalance>("/credits/balance"); }
  bundles() { return this.http.get<{ object: "list"; data: CreditBundle[] }>("/credits/bundles"); }
  purchase(params: CreditPurchaseCreateParams, opts?: RequestOptions) { return this.http.post<CreditPurchase>("/credits/purchases", params, opts); }
  getPurchase(id: string) { return this.http.get<CreditPurchase>(`/credits/purchases/${id}`); }
  listPurchases(params?: ListParams & { status?: string }) { return this.http.list<CreditPurchase>("/credits/purchases", params); }
  cancelPurchase(id: string) { return this.http.post<CreditPurchase>(`/credits/purchases/${id}/cancel`); }
  ledger(params?: ListParams & { type?: "debit" | "credit"; reason?: string }) { return this.http.list<CreditLedgerEntry>("/credits/ledger", params); }
  setAutoTopup(params: AutoTopupParams) { return this.http.put<CreditsBalance>("/credits/auto_topup", params); }
  /** Saved cards. Cards are added in the dashboard (Square card form + 2FA), not with an API key. */
  paymentMethods() { return this.http.get<PaymentMethodList>("/credits/payment_methods"); }
}

export class Rates {
  constructor(private readonly http: HttpClient) {}
  list(params?: { base?: string; assets?: string[] }) {
    return this.http.get<{ object: "rates"; base: string; rates: { asset: string; rate: string }[]; as_of: string }>("/rates", { base: params?.base, assets: params?.assets?.join(",") });
  }
  /** Public fiat display rates (no auth needed; indicative, for showing prices in the payer's currency). */
  display(base?: string) { return this.http.get<{ object: "display_rates"; base: string; rates: Record<string, string>; as_of: string; source?: string }>("/rates/display", base ? { base } : undefined); }
  quote(params: { from: string; to: string; amount: string; side?: "from" | "to" }) { return this.http.post<RateQuote>("/rates/quotes", params); }
  lock(quoteId: string, durationSeconds?: number, opts?: RequestOptions) { return this.http.post<RateLock>("/rates/locks", { quote_id: quoteId, duration_seconds: durationSeconds }, opts); }
  getLock(id: string) { return this.http.get<RateLock>(`/rates/locks/${id}`); }
}

export class Conversions {
  constructor(private readonly http: HttpClient) {}
  quote(params: Record<string, unknown>) { return this.http.post<Record<string, unknown>>("/conversions/quotes", params); }
  create(quoteId: string, metadata?: Record<string, string>, opts?: RequestOptions) { return this.http.post<Conversion>("/conversions", { quote_id: quoteId, metadata }, opts); }
  get(id: string) { return this.http.get<Conversion>(`/conversions/${id}`); }
  list(params?: ListParams & { status?: string }) { return this.http.list<Conversion>("/conversions", params); }
  submit(id: string, submission: SignedSubmission) { return this.http.post<Conversion>(`/conversions/${id}/submit`, submission); }
  cancel(id: string) { return this.http.post<Conversion>(`/conversions/${id}/cancel`); }
}

export class Offramp {
  constructor(private readonly http: HttpClient) {}
  providers() { return this.http.get<{ object: "list"; data: Record<string, unknown>[] }>("/offramp/providers"); }
  connectAccount(params: Record<string, unknown>, opts?: RequestOptions) { return this.http.post<Record<string, unknown>>("/offramp/accounts", params, opts); }
  getAccount(id: string) { return this.http.get<Record<string, unknown>>(`/offramp/accounts/${id}`); }
  listAccounts(params?: ListParams) { return this.http.list<Record<string, unknown>>("/offramp/accounts", params); }
  disconnectAccount(id: string) { return this.http.delete<Record<string, unknown>>(`/offramp/accounts/${id}`); }
  quote(params: Record<string, unknown>) { return this.http.post<Record<string, unknown>>("/offramp/quotes", params); }
  createPayout(params: { quote_id: string; from_wallet_id: string; metadata?: Record<string, string> }, opts?: RequestOptions) { return this.http.post<Record<string, unknown>>("/offramp/payouts", params, opts); }
  getPayout(id: string) { return this.http.get<Record<string, unknown>>(`/offramp/payouts/${id}`); }
  listPayouts(params?: ListParams & { status?: string }) { return this.http.list<Record<string, unknown>>("/offramp/payouts", params); }
  submitPayout(id: string, submission: SignedSubmission) { return this.http.post<Record<string, unknown>>(`/offramp/payouts/${id}/submit`, submission); }
  cancelPayout(id: string) { return this.http.post<Record<string, unknown>>(`/offramp/payouts/${id}/cancel`); }
}

export class CheckoutSessions {
  constructor(private readonly http: HttpClient) {}
  create(params: CheckoutSessionCreateParams, opts?: RequestOptions) { return this.http.post<CheckoutSession>("/checkout-sessions", params, opts); }
  get(id: string, expandInvoice = false) { return this.http.get<CheckoutSession>(`/checkout-sessions/${id}`, expandInvoice ? { expand: "invoice" } : undefined); }
  list(params?: ListParams & { status?: string }) { return this.http.list<CheckoutSession>("/checkout-sessions", params); }
  expire(id: string) { return this.http.post<CheckoutSession>(`/checkout-sessions/${id}/expire`); }
  /** Public, unauthenticated payer view (what pay.coinvello.com renders). Safe to call from a browser. */
  static async fetchPublic(id: string, baseUrl = "https://api.coinvello.com/v1", fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
    const res = await fetchImpl(`${baseUrl}/checkout-sessions/${encodeURIComponent(id)}/public`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Public session fetch failed (${res.status})`);
    return (await res.json()) as Record<string, unknown>;
  }
  /** URL of the public SSE stream for use with `new EventSource(url)`. */
  static eventsUrl(id: string, baseUrl = "https://api.coinvello.com/v1") { return `${baseUrl}/checkout-sessions/${encodeURIComponent(id)}/events`; }
}

export class Refunds {
  constructor(private readonly http: HttpClient) {}
  create(params: RefundCreateParams, opts?: RequestOptions) { return this.http.post<Refund>("/refunds", params, opts); }
  get(id: string) { return this.http.get<Refund>(`/refunds/${id}`); }
  list(params?: ListParams & { invoice_id?: string; status?: string }) { return this.http.list<Refund>("/refunds", params); }
  submit(id: string, submission: SignedSubmission) { return this.http.post<Refund>(`/refunds/${id}/submit`, submission); }
  cancel(id: string) { return this.http.post<Refund>(`/refunds/${id}/cancel`); }
}

export class Events {
  constructor(private readonly http: HttpClient) {}
  get(id: string) { return this.http.get<Event>(`/events/${id}`); }
  list(params?: ListParams & { type?: string; related_object_id?: string }) { return this.http.list<Event>("/events", params); }
  /** Re-deliver one event to a specific endpoint, or to every subscribed endpoint when webhookId is omitted. */
  resend(id: string, webhookId?: string, opts?: RequestOptions) { return this.http.post<{ object: "event_resend"; event_id: string; deliveries: WebhookDelivery[] }>(`/events/${id}/resend`, webhookId ? { webhook_id: webhookId } : {}, opts); }
}

export interface MerchantAccount { id: string; object: "account"; email: string; business_name: string | null; status: string; mfa_required?: boolean; locale: string | null; display_currency: string | null;
  billing_plan?: "prepaid" | "pay_as_you_go";
  /** On by default: when the credits run out, a prepaid account switches to pay as you go instead of refusing invoices (402). */
  auto_switch_to_pay_as_you_go?: boolean;
  records?: RecordsSettings; api_version: string; created_at: string; last_seen_at?: string | null }
export class Account {
  constructor(private http: HttpClient) {}
  get() { return this.http.get<MerchantAccount>("/account"); }
  update(params: { business_name?: string | null; locale?: string | null; display_currency?: string | null; billing_plan?: "prepaid" | "pay_as_you_go"; auto_switch_to_pay_as_you_go?: boolean; records?: Partial<RecordsSettings> }) { return this.http.patch<MerchantAccount>("/account", params); }
}

/** The book of record behind the account: one immutable row per movement of value, valued when it happened. */
export class Records {
  constructor(private readonly http: HttpClient) {}
  list(params?: RecordListParams) { return this.http.list<AccountingRecord>("/records", params); }
  retrieve(id: string, params?: { currency?: string }) { return this.http.get<AccountingRecord>(`/records/${id}`, params); }
  get(id: string, params?: { currency?: string }) { return this.retrieve(id, params); }
  /** Sales, market value received, refunds, fees and net received for a period, optionally grouped. */
  summary(params: RecordsSummaryParams) { return this.http.get<RecordsSummary>("/records/summary", { ...params }); }
}

/** CSV, Excel and JSON files of records or any dataset; kept 7 days. */
export class Exports {
  constructor(private readonly http: HttpClient) {}
  create(params: ExportCreateParams, opts?: RequestOptions) { return this.http.post<Export>("/exports", params, opts); }
  list(params?: ListParams & { status?: ExportStatus; dataset?: ExportDataset }) { return this.http.list<Export>("/exports", params); }
  retrieve(id: string) { return this.http.get<Export>(`/exports/${id}`); }
  get(id: string) { return this.retrieve(id); }
  delete(id: string) { return this.http.delete<{ id: string; object: "export"; deleted: true }>(`/exports/${id}`); }
  /** The file's bytes (`409 export_not_ready` while queued or processing). Follows the redirect to the signed URL without sending your API key. */
  download(id: string, opts?: RequestOptions) { return this.http.download(`/exports/${id}/download`, opts); }
}

export class Assets {
  constructor(private readonly http: HttpClient) {}
  list() { return this.http.get<{ object: "list"; data: Record<string, unknown>[] }>("/assets"); }
}

export class Test {
  constructor(private readonly http: HttpClient) {}
  /** Test mode only. */
  simulatePayment(params: SimulatePaymentParams, opts?: RequestOptions) { return this.http.post<{ payment: Payment; invoice: Invoice }>("/test/simulate_payment", params, opts); }
  /** Test mode only: record a sweep of a pay-as-you-go receiver's unswept invoices. */
  simulateSweep(params: { receiver_id: string; assets?: string[]; initiated_by?: Sweep["initiated_by"]; fee_destination?: Sweep["fee_destination"] }, opts?: RequestOptions) { return this.http.post<Sweep>("/test/simulate_sweep", params, opts); }
}

/** Pay as you go: the merchant-owned receivers payments go to (created automatically while billing_plan is pay_as_you_go). */
export class Receivers {
  constructor(private readonly http: HttpClient) {}
  get(id: string) { return this.http.get<Receiver>(`/receivers/${id}`); }
  list(params?: ListParams & { chain?: Chain; wallet_id?: string; status?: Receiver["status"] }) { return this.http.list<Receiver>("/receivers", params); }
  /** An unsigned transaction that sweeps the receiver now, signed by `from` (who pays the network fee). */
  prepareSweep(id: string, params: { from: string; assets?: string[] }, opts?: RequestOptions) { return this.http.post<SweepTransaction>(`/receivers/${id}/sweep_transaction`, params, opts); }
}

/** Pay as you go: every on-chain split of a receiver, whoever triggered it. */
export class Sweeps {
  constructor(private readonly http: HttpClient) {}
  get(id: string) { return this.http.get<Sweep>(`/sweeps/${id}`); }
  list(params?: ListParams & { receiver_id?: string; chain?: Chain; status?: Sweep["status"] }) { return this.http.list<Sweep>("/sweeps", params); }
}
