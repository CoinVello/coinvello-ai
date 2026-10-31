import { createHmac, timingSafeEqual } from "node:crypto";
import { SignatureVerificationError } from "./errors.js";
import type { Event } from "./types.js";

export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Compute the `CoinVello-Signature` header value for a payload. Used by the reference server
 * and useful in tests.
 */
export function signPayload(rawBody: string | Buffer, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Verify a webhook delivery and return the parsed event.
 *
 * @param rawBody   The raw request body bytes (NOT re-serialised JSON).
 * @param header    Value of the `CoinVello-Signature` header: `t=<unix>,v1=<hex>[,v1=<hex>]`.
 * @param secret    Endpoint secret (`whsec_...`).
 * @param tolerance Max age of the timestamp in seconds (default 300).
 */
export function constructEvent<T = Record<string, unknown>>(
  rawBody: string | Buffer,
  header: string | undefined | null,
  secret: string,
  tolerance = DEFAULT_TOLERANCE_SECONDS,
  now = Math.floor(Date.now() / 1000),
): Event<T> {
  if (!header) throw new SignatureVerificationError("Missing CoinVello-Signature header");
  if (!secret) throw new SignatureVerificationError("Missing webhook secret");

  let t = 0;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") sigs.push(v);
  }
  if (!t || !Number.isFinite(t)) throw new SignatureVerificationError("Malformed signature header: missing timestamp");
  if (sigs.length === 0) throw new SignatureVerificationError("Malformed signature header: no v1 signature");
  if (Math.abs(now - t) > tolerance) throw new SignatureVerificationError("Timestamp outside the tolerance window");

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secret).update(`${t}.`).update(body).digest();
  const ok = sigs.some((s) => {
    let candidate: Buffer;
    try { candidate = Buffer.from(s, "hex"); } catch { return false; }
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!ok) throw new SignatureVerificationError("No signatures found matching the expected signature for payload");

  try {
    return JSON.parse(body.toString("utf8")) as Event<T>;
  } catch {
    throw new SignatureVerificationError("Payload is not valid JSON");
  }
}

export const Webhooks = { constructEvent, signPayload };
