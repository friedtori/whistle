import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { LicencePayload } from "../src/verification.ts";
import {
  BLINDING_LIGHTS,
  client,
  freshStore,
  hit,
  mockProviders,
  stubProvider,
  testApp,
  type TestResponse,
} from "./helpers.ts";
import { signEnvelope, testLicenceKeys } from "./licence-keys.ts";

const START = Date.UTC(2026, 10, 3, 12, 0, 0);
const SESSION_SECRET = "test-session-secret-0123456789abcdef";
const COOKIE_RE =
  /^__Host-whistle=([A-Za-z0-9._-]+); Secure; HttpOnly; Path=\/; SameSite=Strict; Max-Age=604800$/;
const QUERY = { isrc: BLINDING_LIGHTS.isrc };
const IP = { "CF-Connecting-IP": "198.51.100.23" };

let now = START;
let keys: Awaited<ReturnType<typeof testLicenceKeys>>;
let api: ReturnType<typeof client>;

async function setup(verification: { sessionSecret?: string; verifiedResolvesPerDay?: number } = {}) {
  now = START;
  keys = await testLicenceKeys();
  const db = await freshStore();
  const providers = mockProviders({
    deezer: stubProvider("deezer", { byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") } }),
  });
  api = client(
    testApp(db, providers, {
      now: () => now,
      verification: {
        anonResolvesPerHour: 2,
        verifiedResolvesPerDay: verification.verifiedResolvesPerDay ?? 4,
        gumLicensePublicKey: keys.publicKeyBase64,
        sessionSecret: "sessionSecret" in verification ? verification.sessionSecret : SESSION_SECRET,
      },
    }),
  );
}

/** Spend the anonymous quota and return the 429 challenge. */
async function challenge(): Promise<TestResponse> {
  let res: TestResponse;
  do {
    res = await api.get("/v1/resolve", QUERY, IP);
  } while (res.status === 200);
  return res;
}

function proof(nonce: string, overrides: Partial<LicencePayload> = {}) {
  return signEnvelope(keys.privateKey, {
    status: "licensed",
    days_remaining: 200,
    days_allowed: 365,
    server_time: now,
    nonce,
    activation_id: "act_test",
    device_limit: 3,
    ...overrides,
  });
}

async function verify(nonce: string, overrides: Partial<LicencePayload> = {}) {
  return api.post("/auth/session", await proof(nonce, overrides), IP);
}

function cookieFrom(res: TestResponse): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = COOKIE_RE.exec(header);
  if (!match) throw new Error(`unexpected Set-Cookie: ${header}`);
  return `__Host-whistle=${match[1]}`;
}

async function nonceRow(nonce: string) {
  return env.DB.prepare("SELECT * FROM verification_nonces WHERE nonce = ?")
    .bind(nonce)
    .first<{ issued_at: number; expires_at: number; used_at: number | null }>();
}

describe("anonymous quota → 429 challenge", () => {
  beforeEach(() => setup());

  it("serves anonymous resolves up to the quota, then returns the exact challenge body", async () => {
    expect((await api.get("/v1/resolve", QUERY, IP)).status).toBe(200);
    expect((await api.get("/v1/resolve", QUERY, IP)).status).toBe(200);
    const res = await api.get("/v1/resolve", QUERY, IP);
    expect(res.status).toBe(429);
    expect(Object.keys(res.body).sort()).toEqual(["error", "verification"]);
    expect(res.body.error).toEqual({ code: "verification_required" });
    expect(Object.keys(res.body.verification).sort()).toEqual(["endpoint", "expires_at", "nonce"]);
    const { nonce, expires_at, endpoint } = res.body.verification;
    expect(endpoint).toBe("/auth/session");
    expect(nonce.startsWith("whistle.")).toBe(true);
    expect(nonce.length).toBeGreaterThanOrEqual(8);
    expect(nonce.length).toBeLessThanOrEqual(128);
    expect(nonce).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(expires_at).toBe(START + 5 * 60 * 1000);
    expect(Number.isInteger(expires_at)).toBe(true);
    expect(await nonceRow(nonce)).toMatchObject({ issued_at: START, expires_at, used_at: null });
  });

  it("counts per client network: another address still has its own quota", async () => {
    await challenge();
    expect((await api.get("/v1/resolve", QUERY, { "CF-Connecting-IP": "198.51.100.99" })).status).toBe(200);
  });

  it("resets the anonymous quota in the next hour window", async () => {
    await challenge();
    now = START + 60 * 60 * 1000;
    expect((await api.get("/v1/resolve", QUERY, IP)).status).toBe(200);
  });

  it("challenges an anonymous batch that would exceed the quota (inputs count individually)", async () => {
    const res = await api.post(
      "/v1/resolve/batch",
      { inputs: [QUERY, QUERY, QUERY] },
      IP,
    );
    expect(res.status).toBe(429);
    expect(res.body.error).toEqual({ code: "verification_required" });
    expect(res.body.verification.endpoint).toBe("/auth/session");
  });
});

describe("POST /auth/session", () => {
  beforeEach(() => setup());

  it("accepts a valid proof: 204, exact __Host- cookie, no Domain, nonce marked used", async () => {
    const { nonce } = (await challenge()).body.verification;
    const res = await verify(nonce);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    const header = res.headers.get("set-cookie")!;
    expect(header).toMatch(COOKIE_RE);
    expect(header.toLowerCase()).not.toContain("domain=");
    expect(res.headers.get("location")).toBeNull();
    expect((await nonceRow(nonce))?.used_at).toBe(now);
  });

  it("accepts status trial", async () => {
    const { nonce } = (await challenge()).body.verification;
    expect((await verify(nonce, { status: "trial", days_remaining: 10, days_allowed: 14 })).status).toBe(204);
  });

  it.each(["expired", "revoked", "seat_limit", "suspended"])("rejects status %s with 403", async (status) => {
    const { nonce } = (await challenge()).body.verification;
    const res = await verify(nonce, { status });
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect((await nonceRow(nonce))?.used_at).toBeNull();
  });

  it("rejects a bad signature with 403", async () => {
    const { nonce } = (await challenge()).body.verification;
    const envelope = await proof(nonce);
    const forged = { ...envelope, payload: { ...envelope.payload, days_remaining: 9999 } };
    expect((await api.post("/auth/session", forged, IP)).status).toBe(403);
    const other = await testLicenceKeys();
    const foreign = await signEnvelope(other.privateKey, envelope.payload);
    expect((await api.post("/auth/session", foreign, IP)).status).toBe(403);
  });

  it("rejects server_time more than 10 minutes off with 403", async () => {
    const { nonce } = (await challenge()).body.verification;
    expect((await verify(nonce, { server_time: now + 10 * 60 * 1000 + 1 })).status).toBe(403);
    expect((await verify(nonce, { server_time: now - 11 * 60 * 1000 })).status).toBe(403);
    expect((await verify(nonce, { server_time: now - 9 * 60 * 1000 })).status).toBe(204);
  });

  it("rejects a well-formed nonce Whistle never issued with 403", async () => {
    await challenge();
    expect((await verify("whistle.neverIssuedButWellFormed123")).status).toBe(403);
  });

  it("rejects an expired nonce (TTL 5 minutes) with 403", async () => {
    const { nonce } = (await challenge()).body.verification;
    now = START + 5 * 60 * 1000;
    expect((await verify(nonce)).status).toBe(403);
  });

  it("is single use: replaying an accepted envelope is 403", async () => {
    const { nonce } = (await challenge()).body.verification;
    const envelope = await proof(nonce);
    expect((await api.post("/auth/session", envelope, IP)).status).toBe(204);
    const again = await api.post("/auth/session", envelope, IP);
    expect(again.status).toBe(403);
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    ["non-JSON body", "{nope"],
    ["empty object", {}],
    ["missing sig", { payload: { status: "licensed" } }],
    ["string payload", { payload: "x", sig: "y" }],
    ["days_remaining as string", {
      payload: { status: "licensed", days_remaining: "1", days_allowed: 1, server_time: START, nonce: "whistle.x" },
      sig: "AAAA",
    }],
  ])("returns 400 for a malformed body: %s", async (_label, body) => {
    await challenge();
    const res = await api.post("/auth/session", body, IP);
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers only at the root path, without redirects", async () => {
    const { nonce } = (await challenge()).body.verification;
    const slash = await api.post("/auth/session/", await proof(nonce), IP);
    expect(slash.status).toBe(404);
    expect(slash.headers.get("location")).toBeNull();
    expect((await api.post("/api/auth/session", await proof(nonce), IP)).status).toBe(404);
  });

  it("is unavailable (503, never 204) when SESSION_SECRET is not configured", async () => {
    await setup({ sessionSecret: undefined });
    const { nonce } = (await challenge()).body.verification;
    const res = await verify(nonce);
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("verified session", () => {
  beforeEach(() => setup({ verifiedResolvesPerDay: 4 }));

  it("the client's single replay of the identical query succeeds with the cookie", async () => {
    const first = await challenge();
    const cookie = cookieFrom(await verify(first.body.verification.nonce));
    const replay = await api.get("/v1/resolve", QUERY, {
      ...IP,
      Cookie: cookie,
      Accept: "application/json",
    });
    expect(replay.status).toBe(200);
    expect(replay.body.recording.title).toBe("Blinding Lights");
  });

  it("never gets verification_required during the session, even past its own quota", async () => {
    const cookie = cookieFrom(await verify((await challenge()).body.verification.nonce));
    const headers = { ...IP, Cookie: cookie, Accept: "application/json" };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await api.get("/v1/resolve", QUERY, headers);
      statuses.push(res.status);
      expect(res.body?.error?.code).not.toBe("verification_required");
      if (res.status === 429) {
        expect(res.body.error.code).toBe("rate_limited");
        expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      }
      now += 60 * 60 * 1000; // hours pass; the anonymous window resets, the daily one does not
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);

    // Later in the session's life (a new UTC day) the verified quota is back.
    now = START + 3 * 24 * 60 * 60 * 1000;
    expect((await api.get("/v1/resolve", QUERY, headers)).status).toBe(200);
  });

  it("verified batches are counted against the session, not challenged", async () => {
    const cookie = cookieFrom(await verify((await challenge()).body.verification.nonce));
    const res = await api.post("/v1/resolve/batch", { inputs: [QUERY, QUERY, QUERY] }, { ...IP, Cookie: cookie });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
  });

  it("a tampered or expired cookie is anonymous again (and challenged when over quota)", async () => {
    const cookie = cookieFrom(await verify((await challenge()).body.verification.nonce));
    const tampered = await api.get("/v1/resolve", QUERY, { ...IP, Cookie: `${cookie.slice(0, -2)}xx` });
    expect(tampered.status).toBe(429);
    expect(tampered.body.error.code).toBe("verification_required");

    now = START + 7 * 24 * 60 * 60 * 1000 + 1;
    await challenge(); // spend the new hour's anonymous quota
    const expired = await api.get("/v1/resolve", QUERY, { ...IP, Cookie: cookie });
    expect(expired.status).toBe(429);
    expect(expired.body.error.code).toBe("verification_required");
  });
});
