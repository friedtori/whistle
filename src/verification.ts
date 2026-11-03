/**
 * Gum heavy-use verification: framework-free logic.
 *
 * Flow (contract fixed by the shipped Gum client):
 *   1. Over the anonymous quota, resolve answers 429 with a `whistle.` nonce.
 *   2. Gum takes the nonce to its licence Worker, which returns a signed
 *      envelope `{ payload, sig }` (Ed25519 over `canonicalize(payload)`).
 *   3. Gum POSTs the envelope unchanged to /auth/session. Whistle accepts it
 *      only when the signature verifies, the status is trial/licensed, the
 *      licence server's clock is within ±10 minutes, and the nonce is an
 *      issued, unexpired, unused one (nonce bookkeeping lives in D1; see
 *      auth-store.ts). Then it sets a 7-day session cookie.
 *
 * Everything here uses WebCrypto only, so it runs in Workers and in Node.
 */

export const NONCE_PREFIX = "whistle.";
export const NONCE_TTL_MS = 5 * 60 * 1000;
export const NONCE_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
export const SERVER_TIME_SKEW_MS = 10 * 60 * 1000;
export const ACCEPTED_STATUSES: ReadonlySet<string> = new Set(["trial", "licensed"]);

export const SESSION_COOKIE = "__Host-whistle";
export const SESSION_TTL_S = 7 * 24 * 60 * 60;

// --- encoding helpers --------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes standard or URL-safe base64, padded or not. Returns null when invalid. */
export function base64ToBytes(value: string): Uint8Array | null {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// --- nonces ------------------------------------------------------------------

/** `whistle.` + 32 base64url chars (24 random bytes): 40 chars, all in [A-Za-z0-9._-]. */
export function generateNonce(): string {
  return `${NONCE_PREFIX}${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)))}`;
}

export function isWellFormedNonce(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(NONCE_PREFIX) && NONCE_PATTERN.test(value);
}

// --- envelope ----------------------------------------------------------------

export interface LicencePayload {
  status: string;
  days_remaining: number;
  days_allowed: number;
  server_time: number;
  nonce: string;
  activation_id?: string | null;
  device_limit?: number | null;
  /** Any further fields the licence Worker adds are signed too, so they are kept. */
  [extra: string]: unknown;
}

export interface LicenceEnvelope {
  payload: LicencePayload;
  sig: string;
}

/**
 * The licence Worker's canonical form: top-level keys sorted, null/undefined
 * fields omitted, `JSON.stringify` with no whitespace.
 */
export function canonicalize(payload: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return JSON.stringify(out);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || value === null || check(value);
}

/** Shape check only (HTTP 400 when it fails). Says nothing about authenticity. */
export function parseEnvelope(body: unknown): LicenceEnvelope | null {
  if (!isRecord(body) || !isRecord(body.payload) || typeof body.sig !== "string" || !body.sig) {
    return null;
  }
  const p = body.payload;
  const ok =
    typeof p.status === "string" &&
    Number.isInteger(p.days_remaining) &&
    Number.isInteger(p.days_allowed) &&
    Number.isInteger(p.server_time) &&
    typeof p.nonce === "string" &&
    optional(p.activation_id, (v) => typeof v === "string") &&
    optional(p.device_limit, (v) => Number.isInteger(v));
  return ok ? { payload: p as LicencePayload, sig: body.sig } : null;
}

export async function importLicencePublicKey(base64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64);
  if (!raw || raw.length !== 32) throw new Error("Licence public key must be 32 raw Ed25519 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
}

export async function verifySignature(envelope: LicenceEnvelope, publicKey: CryptoKey): Promise<boolean> {
  const sig = base64ToBytes(envelope.sig);
  if (!sig || sig.length !== 64) return false;
  const data = new TextEncoder().encode(canonicalize(envelope.payload));
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, sig, data);
  } catch {
    return false;
  }
}

/**
 * `server_time` is an integer timestamp. Values below 1e11 are read as
 * seconds (1e11 s is the year 5138), larger values as milliseconds, so either
 * unit from the licence Worker is accepted.
 */
export function serverTimeMs(serverTime: number): number {
  return serverTime < 1e11 ? serverTime * 1000 : serverTime;
}

export type ProofRejection =
  | "bad_signature"
  | "nonce_format"
  | "status_not_accepted"
  | "server_time_skew";

export type ProofCheck = { ok: true; nonce: string } | { ok: false; reason: ProofRejection };

/**
 * Every acceptance rule except nonce bookkeeping (issued / unexpired / unused),
 * which needs storage and is applied by the caller after this passes.
 */
export async function checkProof(
  envelope: LicenceEnvelope,
  options: { publicKey: CryptoKey; now: number },
): Promise<ProofCheck> {
  if (!(await verifySignature(envelope, options.publicKey))) return { ok: false, reason: "bad_signature" };
  const { payload } = envelope;
  if (!isWellFormedNonce(payload.nonce)) return { ok: false, reason: "nonce_format" };
  if (!ACCEPTED_STATUSES.has(payload.status)) return { ok: false, reason: "status_not_accepted" };
  if (Math.abs(serverTimeMs(payload.server_time) - options.now) > SERVER_TIME_SKEW_MS) {
    return { ok: false, reason: "server_time_skew" };
  }
  return { ok: true, nonce: payload.nonce };
}

// --- session token -------------------------------------------------------------

/**
 * Opaque cookie value: `<session id>.<expires ms>.<HMAC-SHA256>` with
 * SESSION_SECRET. Stateless to validate; the session id keys the verified quota.
 */
export interface Session {
  id: string;
  expiresAt: number;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function issueSessionToken(
  secret: string,
  now: number,
  ttlSeconds = SESSION_TTL_S,
): Promise<{ token: string; session: Session }> {
  const id = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const expiresAt = now + ttlSeconds * 1000;
  const body = `${id}.${expiresAt}`;
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(body));
  return { token: `${body}.${bytesToBase64Url(new Uint8Array(mac))}`, session: { id, expiresAt } };
}

export async function readSessionToken(secret: string, token: string, now: number): Promise<Session | null> {
  const match = /^([A-Za-z0-9_-]{16,64})\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return null;
  const [, id, exp] = match;
  const mac = base64ToBytes(match[3]);
  if (!mac) return null;
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    mac,
    new TextEncoder().encode(`${id}.${exp}`),
  );
  const expiresAt = Number(exp);
  if (!valid || !(expiresAt > now)) return null;
  return { id, expiresAt };
}

/** Exactly the attribute set the Gum client requires: no Domain, Secure, HttpOnly, Path=/. */
export function sessionCookieHeader(token: string, maxAgeSeconds = SESSION_TTL_S): string {
  return `${SESSION_COOKIE}=${token}; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// --- quota keys ----------------------------------------------------------------

/**
 * Anonymous quota key for a client address. IPv6 clients are grouped by /64
 * (one subscriber typically controls a whole /64). The address is hashed
 * before it is stored.
 */
export async function anonymousClientKey(ip: string | null | undefined): Promise<string> {
  const address = (ip ?? "").trim() || "unknown";
  const network = address.includes(":") ? ipv6Prefix64(address) : address;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(network));
  return `ip:${bytesToBase64Url(new Uint8Array(digest).slice(0, 16))}`;
}

function ipv6Prefix64(address: string): string {
  const [head, tail = ""] = address.split("%")[0].split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = address.includes("::") ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(0, missing)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (g || "0").toLowerCase().replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}
