import { HttpClient, type ClientOptions } from "./http.js";
import {
  Assets, CheckoutSessions, Conversions, Credits, Events, Exports, Invoices, Offramp, Payments, Rates, Records,
  Refunds, Test, Wallets, WebhooksResource, Receivers, Sweeps,
} from "./resources.js";

export * from "./types.js";
export * from "./errors.js";
export { constructEvent, signPayload, Webhooks } from "./webhooks.js";
export type { ClientOptions } from "./http.js";

/**
 * CoinVello API client.
 *
 * ```ts
 * const cv = new CoinVello(process.env.COINVELLO_API_KEY!);
 * const invoice = await cv.invoices.create({ amount: "49.99", currency: "USD" });
 * ```
 */
export class CoinVello {
  readonly invoices: Invoices;
  readonly payments: Payments;
  readonly wallets: Wallets;
  readonly webhooks: WebhooksResource;
  readonly credits: Credits;
  readonly rates: Rates;
  readonly conversions: Conversions;
  readonly offramp: Offramp;
  readonly checkoutSessions: CheckoutSessions;
  readonly refunds: Refunds;
  readonly events: Events;
  readonly assets: Assets;
  readonly test: Test;
  readonly receivers: Receivers;
  readonly sweeps: Sweeps;
  readonly records: Records;
  readonly exports: Exports;
  readonly livemode: boolean;

  constructor(apiKey: string, options: ClientOptions = {}) {
    const http = new HttpClient(apiKey, options);
    this.livemode = http.livemode;
    this.invoices = new Invoices(http);
    this.payments = new Payments(http);
    this.wallets = new Wallets(http);
    this.webhooks = new WebhooksResource(http);
    this.credits = new Credits(http);
    this.rates = new Rates(http);
    this.conversions = new Conversions(http);
    this.offramp = new Offramp(http);
    this.checkoutSessions = new CheckoutSessions(http);
    this.refunds = new Refunds(http);
    this.events = new Events(http);
    this.assets = new Assets(http);
    this.receivers = new Receivers(http);
    this.sweeps = new Sweeps(http);
    this.records = new Records(http);
    this.exports = new Exports(http);
    this.test = new Test(http);
  }
}

export default CoinVello;
