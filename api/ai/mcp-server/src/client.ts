/**
 * Minimal HTTP client for the CoinVello REST API used by the MCP tools.
 * No SDK dependency so the server stays small and `npx -y @coinvello/mcp` starts fast.
 */
import { randomUUID } from "node:crypto";

export interface CoinVelloClientOptions {
  apiKey: string;
  baseUrl?: string;
  apiVersion?: string;
  timeoutMs?: number;
}

export interface CoinVelloErrorBody {
  type: string;
  code: string;
  message: string;
  param?: string;
  request_id?: string;
  doc_url?: string;
  details?: Record<string, unknown>;
}

export class CoinVelloApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: CoinVelloErrorBody,
  ) {
    super(`${status} ${error.type}/${error.code}: ${error.message}`);
    this.name = "CoinVelloApiError";
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

export class CoinVelloClient {
  readonly baseUrl: string;
  readonly livemode: boolean;
  private readonly apiKey: string;
  private readonly apiVersion?: string;
  private readonly timeoutMs: number;

  constructor(opts: CoinVelloClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.coinvello.com/v1").replace(/\/+$/, "");
    this.apiVersion = opts.apiVersion;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.livemode = /^cv_live_/.test(opts.apiKey);
  }

  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, undefined, query);
  }

  async post<T = unknown>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.request<T>("POST", path, body, undefined, idempotencyKey ?? randomUUID());
  }

  async request<T>(method: string, path: string, body?: unknown, query?: Query, idempotencyKey?: string): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": "coinvello-mcp/0.1.3",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    if (this.apiVersion) headers["CoinVello-Version"] = this.apiVersion;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    if (!res.ok) {
      const err = (json as { error?: CoinVelloErrorBody } | null)?.error ?? {
        type: "api_error",
        code: `http_${res.status}`,
        message: text || res.statusText,
      };
      throw new CoinVelloApiError(res.status, err);
    }
    return json as T;
  }
}
