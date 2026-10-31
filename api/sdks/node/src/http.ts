import { randomUUID } from "node:crypto";
import { CoinVelloError, ConnectionError } from "./errors.js";
import type { ListParams, ListResponse, RequestOptions } from "./types.js";

export interface ClientOptions {
  baseUrl?: string;
  apiVersion?: string;
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
  fetch?: typeof fetch;
}

export const DEFAULT_BASE_URL = "https://api.coinvello.com/v1";
export const DEFAULT_API_VERSION = "2026-10-01";
export const SDK_VERSION = "0.1.1";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, opts: ClientOptions = {}) {
    if (!apiKey || !/^cv_(live|test)_/.test(apiKey)) {
      throw new Error("CoinVello: apiKey must start with cv_live_ or cv_test_");
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.userAgent = opts.userAgent ?? `coinvello-node/${SDK_VERSION} (node ${process.version})`;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  get livemode(): boolean {
    return this.apiKey.startsWith("cv_live_");
  }

  async request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}, query?: Record<string, unknown>): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
      "CoinVello-Version": opts.apiVersion ?? this.apiVersion,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method === "POST") headers["Idempotency-Key"] = opts.idempotencyKey ?? randomUUID();

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      attempt++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (attempt <= this.maxRetries) { await sleep(backoff(attempt)); continue; }
        throw new ConnectionError(`Request to ${url.pathname} failed: ${(e as Error).message}`, e);
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 204) return undefined as T;
      const text = await res.text();
      const json = text ? safeJson(text) : undefined;

      if (res.ok) return json as T;

      const err = CoinVelloError.fromResponse(res.status, json, res.headers.get("Retry-After"));
      const retryable =
        res.status >= 500 ||
        res.status === 429 ||
        (res.status === 409 && err.code === "idempotency_key_in_progress");
      if (retryable && attempt <= this.maxRetries) {
        await sleep(err.retryAfter ? err.retryAfter * 1000 : backoff(attempt));
        continue;
      }
      throw err;
    }
  }

  get<T>(path: string, query?: Record<string, unknown>, opts?: RequestOptions) { return this.request<T>("GET", path, undefined, opts, query); }
  post<T>(path: string, body?: unknown, opts?: RequestOptions) { return this.request<T>("POST", path, body ?? {}, opts); }
  patch<T>(path: string, body: unknown, opts?: RequestOptions) { return this.request<T>("PATCH", path, body, opts); }
  put<T>(path: string, body: unknown, opts?: RequestOptions) { return this.request<T>("PUT", path, body, opts); }
  delete<T>(path: string, opts?: RequestOptions) { return this.request<T>("DELETE", path, undefined, opts); }

  /**
   * GET a file. A `200` is the file itself; a redirect points at a signed URL, which is fetched without the API key.
   * Retries like `request` on connection errors, 429 and 5xx.
   */
  async download(path: string, opts: RequestOptions = {}): Promise<Uint8Array> {
    const url = new URL(this.baseUrl + path);
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "*/*",
      "User-Agent": this.userAgent,
      "CoinVello-Version": opts.apiVersion ?? this.apiVersion,
    };
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? this.timeoutMs);
      try {
        res = await this.fetchImpl(url, { headers, redirect: "manual", signal: controller.signal });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          const next = new URL(location, url);
          if (next.protocol !== "https:" && next.protocol !== "http:") throw new Error(`refusing to follow a redirect to ${next.protocol}`);
          res = await this.fetchImpl(next, { signal: controller.signal });
        }
      } catch (e) {
        if (attempt <= this.maxRetries) { await sleep(backoff(attempt)); continue; }
        throw new ConnectionError(`Request to ${url.pathname} failed: ${(e as Error).message}`, e);
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      const text = await res.text();
      const err = CoinVelloError.fromResponse(res.status, text ? safeJson(text) : undefined, res.headers.get("Retry-After"));
      if ((res.status >= 500 || res.status === 429) && attempt <= this.maxRetries) { await sleep(err.retryAfter ? err.retryAfter * 1000 : backoff(attempt)); continue; }
      throw err;
    }
  }

  /** Returns a page and an async iterator that walks all pages. */
  list<T>(path: string, params: ListParams = {}): Promise<ListResponse<T>> & AsyncIterable<T> {
    const first = this.get<ListResponse<T>>(path, params);
    const self = this;
    const iter: AsyncIterable<T> = {
      async *[Symbol.asyncIterator]() {
        let page = await first;
        for (;;) {
          for (const item of page.data) yield item;
          if (!page.has_more || !page.next_cursor) return;
          page = await self.get<ListResponse<T>>(path, { ...params, cursor: page.next_cursor });
        }
      },
    };
    return Object.assign(first, iter);
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { error: { type: "api_error", code: "invalid_json", message: text.slice(0, 200), request_id: "" } }; }
}

function backoff(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return base / 2 + Math.random() * base / 2;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
