import { describe, expect, it } from "vitest";
import {
  anonymousClientKey,
  base64ToBytes,
  bytesToBase64,
  canonicalize,
  checkProof,
  generateNonce,
  importLicencePublicKey,
  isWellFormedNonce,
  issueSessionToken,
  parseEnvelope,
  readCookie,
  readSessionToken,
  serverTimeMs,
  sessionCookieHeader,
  verifySignature,
  type LicencePayload,
} from "../src/verification.ts";
import { signEnvelope, testLicenceKeys } from "./licence-keys.ts";

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

function payload(overrides: Partial<LicencePayload> = {}): LicencePayload {
  return {
    status: "licensed",
    days_remaining: 300,
    days_allowed: 365,
    server_time: NOW,
    nonce: "whistle.abcDEF123_-.xyz",
    ...overrides,
  };
}

describe("canonicalize (licence Worker form)", () => {
  it("sorts keys, omits null/undefined, and has no whitespace", () => {
    expect(
      canonicalize({ status: "trial", activation_id: null, nonce: "n", device_limit: undefined, days_allowed: 14 }),
    ).toBe('{"days_allowed":14,"nonce":"n","status":"trial"}');
  });

  it("keeps unknown fields so their signature still verifies", () => {
    expect(canonicalize({ b: 1, a: "x", z: false })).toBe('{"a":"x","b":1,"z":false}');
  });
});

describe("nonces", () => {
  it("start with whistle., are 8-128 chars, and use only [A-Za-z0-9._-]", () => {
    for (let i = 0; i < 50; i += 1) {
      const nonce = generateNonce();
      expect(nonce.startsWith("whistle.")).toBe(true);
      expect(nonce.length).toBeGreaterThanOrEqual(8);
      expect(nonce.length).toBeLessThanOrEqual(128);
      expect(nonce).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(isWellFormedNonce(nonce)).toBe(true);
    }
    expect(generateNonce()).not.toBe(generateNonce());
    expect(isWellFormedNonce("gum.abc")).toBe(false);
    expect(isWellFormedNonce(`whistle.${"a".repeat(121)}`)).toBe(false);
    expect(isWellFormedNonce("whistle.a b")).toBe(false);
  });
});

describe("envelope shape", () => {
  it("accepts the documented shape, with optional activation_id / device_limit", () => {
    expect(parseEnvelope({ payload: payload(), sig: "x" })).not.toBeNull();
    expect(
      parseEnvelope({ payload: payload({ activation_id: "act_1", device_limit: 3 }), sig: "x" }),
    ).not.toBeNull();
    expect(parseEnvelope({ payload: payload({ activation_id: null }), sig: "x" })).not.toBeNull();
  });

  it.each([
    ["not an object", "nope"],
    ["missing payload", { sig: "x" }],
    ["missing sig", { payload: payload() }],
    ["empty sig", { payload: payload(), sig: "" }],
    ["status not a string", { payload: payload({ status: 1 as unknown as string }), sig: "x" }],
    ["days_remaining not an int", { payload: payload({ days_remaining: 1.5 }), sig: "x" }],
    ["days_allowed missing", { payload: { ...payload(), days_allowed: undefined }, sig: "x" }],
    ["server_time a string", { payload: payload({ server_time: "1" as unknown as number }), sig: "x" }],
    ["nonce missing", { payload: { ...payload(), nonce: undefined }, sig: "x" }],
    ["device_limit not an int", { payload: payload({ device_limit: "3" as unknown as number }), sig: "x" }],
  ])("rejects a malformed body: %s", (_label, body) => {
    expect(parseEnvelope(body)).toBeNull();
  });
});

describe("Ed25519 signature + acceptance rules", () => {
  it("verifies a payload signed by the licence key", async () => {
    const keys = await testLicenceKeys();
    const publicKey = await importLicencePublicKey(keys.publicKeyBase64);
    const envelope = await signEnvelope(keys.privateKey, payload({ activation_id: null }));
    expect(await verifySignature(envelope, publicKey)).toBe(true);
    expect(await checkProof(envelope, { publicKey, now: NOW })).toEqual({
      ok: true,
      nonce: envelope.payload.nonce,
    });
  });

  it("accepts trial and licensed", async () => {
    const keys = await testLicenceKeys();
    const publicKey = await importLicencePublicKey(keys.publicKeyBase64);
    for (const status of ["trial", "licensed"]) {
      const envelope = await signEnvelope(keys.privateKey, payload({ status }));
      expect((await checkProof(envelope, { publicKey, now: NOW })).ok).toBe(true);
    }
  });

  it.each(["expired", "revoked", "seat_limit", "Licensed", "", "unknown"])(
    "rejects status %j",
    async (status) => {
      const keys = await testLicenceKeys();
      const publicKey = await importLicencePublicKey(keys.publicKeyBase64);
      const envelope = await signEnvelope(keys.privateKey, payload({ status }));
      expect(await checkProof(envelope, { publicKey, now: NOW })).toEqual({
        ok: false,
        reason: "status_not_accepted",
      });
    },
  );

  it("rejects a tampered payload, a signature from another key, and a garbage signature", async () => {
    const keys = await testLicenceKeys();
    const other = await testLicenceKeys();
    const publicKey = await importLicencePublicKey(keys.publicKeyBase64);
    const envelope = await signEnvelope(keys.privateKey, payload({ status: "expired" }));
    const tampered = { ...envelope, payload: { ...envelope.payload, status: "licensed" } };
    expect(await checkProof(tampered, { publicKey, now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    const foreign = await signEnvelope(other.privateKey, payload());
    expect(await checkProof(foreign, { publicKey, now: NOW })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await checkProof({ ...envelope, sig: "AAAA" }, { publicKey, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await checkProof({ ...envelope, sig: "%%%" }, { publicKey, now: NOW })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("verifies url-safe base64 signatures too", async () => {
    const keys = await testLicenceKeys();
    const publicKey = await importLicencePublicKey(keys.publicKeyBase64);
    const envelope = await signEnvelope(keys.privateKey, payload());
    const urlSafe = envelope.sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifySignature({ ...envelope, sig: urlSafe }, publicKey)).toBe(true);
  });

  it("requires server_time within ±10 minutes (ms or s)", async () => {
    const keys = await testLicenceKeys();
    const publicKey = await importLicencePublicKey(keys.publicKeyBase64);
    const at = async (server_time: number) =>
      checkProof(await signEnvelope(keys.privateKey, payload({ server_time })), { publicKey, now: NOW });
    const tenMin = 10 * 60 * 1000;
    expect((await at(NOW + tenMin)).ok).toBe(true);
    expect((await at(NOW - tenMin)).ok).toBe(true);
    expect(await at(NOW + tenMin + 1)).toEqual({ ok: false, reason: "server_time_skew" });
    expect(await at(NOW - tenMin - 1)).toEqual({ ok: false, reason: "server_time_skew" });
    expect((await at(Math.floor(NOW / 1000))).ok).toBe(true);
    expect(await at(Math.floor(NOW / 1000) - 3600)).toEqual({ ok: false, reason: "server_time_skew" });
    expect(serverTimeMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(serverTimeMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("rejects a signed nonce that is not a Whistle nonce", async () => {
    const keys = await testLicenceKeys();
    const publicKey = await importLicencePublicKey(keys.publicKeyBase64);
    const envelope = await signEnvelope(keys.privateKey, payload({ nonce: "gum.12345678" }));
    expect(await checkProof(envelope, { publicKey, now: NOW })).toEqual({ ok: false, reason: "nonce_format" });
  });

  it("imports the production public key from vars as a 32-byte Ed25519 key", async () => {
    const raw = base64ToBytes("pkYYXaSz0geqU0mG5eCqr8v9QPIJffVSxpyNpH9THnU=");
    expect(raw?.length).toBe(32);
    await expect(importLicencePublicKey("pkYYXaSz0geqU0mG5eCqr8v9QPIJffVSxpyNpH9THnU=")).resolves.toBeDefined();
    await expect(importLicencePublicKey("c2hvcnQ=")).rejects.toThrow(/32 raw/);
  });
});

describe("session cookie", () => {
  const secret = "test-session-secret-0123456789abcdef";

  it("round-trips an HMAC token and rejects tampering, another secret, and expiry", async () => {
    const { token, session } = await issueSessionToken(secret, NOW);
    expect(session.expiresAt).toBe(NOW + 7 * 24 * 60 * 60 * 1000);
    expect(await readSessionToken(secret, token, NOW + 1000)).toEqual(session);
    expect(await readSessionToken("another-secret-0123456789abcdefgh", token, NOW)).toBeNull();
    const [id, exp, mac] = token.split(".");
    expect(await readSessionToken(secret, `${id}.${Number(exp) + 1}.${mac}`, NOW)).toBeNull();
    expect(await readSessionToken(secret, `${id}x.${exp}.${mac}`, NOW)).toBeNull();
    expect(await readSessionToken(secret, token, session.expiresAt)).toBeNull();
    expect(await readSessionToken(secret, "garbage", NOW)).toBeNull();
  });

  it("formats Set-Cookie exactly as the Gum client requires", async () => {
    const { token } = await issueSessionToken(secret, NOW);
    const header = sessionCookieHeader(token);
    expect(header).toBe(`__Host-whistle=${token}; Secure; HttpOnly; Path=/; SameSite=Strict; Max-Age=604800`);
    expect(header.toLowerCase()).not.toContain("domain=");
    expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("reads the cookie from a Cookie header", () => {
    expect(readCookie("a=1; __Host-whistle=tok.1.x; b=2", "__Host-whistle")).toBe("tok.1.x");
    expect(readCookie("whistle=tok", "__Host-whistle")).toBeNull();
    expect(readCookie(null, "__Host-whistle")).toBeNull();
  });
});

describe("anonymous client key", () => {
  it("hashes the address and groups IPv6 by /64", async () => {
    const v4 = await anonymousClientKey("203.0.113.7");
    expect(v4).toMatch(/^ip:[A-Za-z0-9_-]{22}$/);
    expect(v4).not.toContain("203");
    expect(await anonymousClientKey("203.0.113.8")).not.toBe(v4);
    const a = await anonymousClientKey("2001:db8:1:2:aaaa::1");
    expect(await anonymousClientKey("2001:0db8:0001:0002:ffff:1:2:3")).toBe(a);
    expect(await anonymousClientKey("2001:db8:1:3::1")).not.toBe(a);
    expect(await anonymousClientKey(undefined)).toBe(await anonymousClientKey(""));
  });
});
