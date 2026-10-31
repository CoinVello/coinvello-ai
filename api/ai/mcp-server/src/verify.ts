/**
 * CoinVello webhook signature verification.
 *
 * Header:  CoinVello-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>[,v1=<hex>]
 * Signed:  "<t>.<raw body>"  with HMAC-SHA256 keyed by the endpoint secret (whsec_..., UTF-8, prefix included)
 * Rules:   reject if |now - t| > tolerance (300 s); constant-time compare against any v1; dedupe on event.id
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyResult {
  valid: boolean;
  reason?: string;
  timestamp?: number;
  age_seconds?: number;
  expected_v1?: string;
  event?: unknown;
}

export function parseSignatureHeader(header: string): { t: number; v1: string[] } {
  let t = 0;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") v1.push(v);
  }
  return { t, v1 };
}

export function computeSignature(secret: string, timestamp: number, rawBody: string | Buffer): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  return createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
}

export function verifyCoinVelloSignature(
  rawBody: string | Buffer,
  header: string,
  secret: string,
  opts: { toleranceSec?: number; now?: number } = {},
): VerifyResult {
  const tolerance = opts.toleranceSec ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (!header) return { valid: false, reason: "missing CoinVello-Signature header" };
  const { t, v1 } = parseSignatureHeader(header);
  if (!t || !Number.isFinite(t)) return { valid: false, reason: "missing or invalid t= in header" };
  const age = Math.abs(now - t);
  if (age > tolerance) return { valid: false, reason: `timestamp outside tolerance (${age}s > ${tolerance}s)`, timestamp: t, age_seconds: age };
  if (v1.length === 0) return { valid: false, reason: "no v1= signature in header", timestamp: t, age_seconds: age };

  const expectedHex = computeSignature(secret, t, rawBody);
  const expected = Buffer.from(expectedHex, "hex");
  const ok = v1.some((s) => {
    const b = Buffer.from(s, "hex");
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
  if (!ok) return { valid: false, reason: "signature mismatch", timestamp: t, age_seconds: age, expected_v1: expectedHex };

  let event: unknown = undefined;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody);
  } catch {
    /* body is not JSON; still a valid signature */
  }
  return { valid: true, timestamp: t, age_seconds: age, expected_v1: expectedHex, event };
}
