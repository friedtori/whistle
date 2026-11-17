import { env, runInDurableObject } from "cloudflare:test";
import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { D1_CALLS_PER_RESOLVE } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { D1Store } from "../src/db.ts";
import { createHttpJson, SubrequestBudget } from "../src/http.ts";
import { createDurableMbGate, MUSICBRAINZ_MAX_QUEUE_MS, type MusicBrainzGate } from "../src/musicbrainz-gate.ts";
import { resolveTrack } from "../src/pipeline.ts";
import { appleToken, clearAppleTokenCache } from "../src/providers/apple.ts";
import { BLINDING_LIGHTS, freshStore, hit, mockProviders, stubMb, stubProvider } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Apple MusicKit JWT (jose, ES256)", () => {
  it("signs a 12 h developer token with kid + iss from a PKCS#8 .p8 key, and caches it", async () => {
    clearAppleTokenCache();
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const config = loadConfig({
      APPLE_TEAM_ID: "TEAM123456",
      APPLE_KEY_ID: "KEY1234567",
      // Single-line, `\n`-escaped form as stored in a secret.
      APPLE_PRIVATE_KEY: pem.replace(/\n/g, "\\n"),
    });
    const token = await appleToken(config);
    expect(decodeProtectedHeader(token)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    const { payload } = await jwtVerify(token, publicKey, { issuer: "TEAM123456" });
    expect(payload.exp! - payload.iat!).toBe(12 * 60 * 60);
    expect(await appleToken(config)).toBe(token);
  });

  it("uses a pre-built APPLE_MUSIC_TOKEN as is", async () => {
    expect(await appleToken(loadConfig({ APPLE_MUSIC_TOKEN: "prebuilt" }))).toBe("prebuilt");
  });
});

describe("subrequest budget", () => {
  it("refuses outbound fetches past the cap without calling fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
    const parent = new SubrequestBudget(10);
    const http = createHttpJson(parent.child(2));
    expect((await http("https://example.test/a")).ok).toBe(true);
    expect((await http("https://example.test/b")).ok).toBe(true);
    const refused = await http("https://example.test/c");
    expect(refused).toMatchObject({ ok: false, status: 0, text: "subrequest_budget_exhausted" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(parent.remaining).toBe(8);
  });

  it("a fresh ISRC resolve stays within the reserved D1 calls", async () => {
    const db = await freshStore();
    const budget = new SubrequestBudget(1000);
    const providers = mockProviders({
      deezer: stubProvider("deezer", { byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") } }),
      apple: stubProvider("apple", { byIsrc: { [BLINDING_LIGHTS.isrc]: hit("apple") } }),
      musicbrainz: stubMb({ byIsrc: { [BLINDING_LIGHTS.isrc]: hit("musicbrainz") } }),
    });
    await resolveTrack({ isrc: BLINDING_LIGHTS.isrc }, { db: new D1Store(db.db, budget), providers });
    expect(budget.spent).toBeGreaterThan(0);
    expect(budget.spent).toBeLessThanOrEqual(D1_CALLS_PER_RESOLVE);

    const cachedBudget = new SubrequestBudget(1000);
    const cached = await resolveTrack(
      { isrc: BLINDING_LIGHTS.isrc },
      { db: new D1Store(db.db, cachedBudget), providers },
    );
    expect(cached.cached).toBe(true);
    expect(cachedBudget.spent).toBeLessThanOrEqual(2);
  });
});

describe("D1 store", () => {
  it("writes nothing when a resolve fails before commit", async () => {
    const db = await freshStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", { byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") } }),
      apple: {
        ...stubProvider("apple"),
        async getByIsrc() {
          return hit("apple");
        },
      },
    });
    // Corrupt a provider result so the pipeline throws after creating the recording.
    const broken = { ...providers, musicbrainz: { ...providers.musicbrainz, enabled: true } };
    Object.defineProperty(broken, "tidal", {
      get() {
        throw new Error("boom");
      },
    });
    await expect(resolveTrack({ isrc: BLINDING_LIGHTS.isrc }, { db, providers: broken })).rejects.toThrow("boom");
    const count = await env.DB.prepare("SELECT count(*) AS n FROM recordings").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("never replaces a matched link, even through a stale snapshot", async () => {
    const db = await freshStore();
    const recording = await db.createRecording({ title: "T", artists: ["A"], duration_ms: 1, mbid: null });
    const matched = await db.upsertLink({
      recordingId: recording.id,
      platform: "deezer",
      url: "https://www.deezer.com/track/1",
      duration_ms: 1,
      confidence: 0.98,
      method: "isrc",
      unmatched: false,
    });
    const again = await db.upsertLink({
      recordingId: recording.id,
      platform: "deezer",
      url: null,
      duration_ms: null,
      confidence: 0,
      method: null,
      unmatched: true,
      skip_reason: "unmatched",
    });
    expect(again).toEqual(matched);
  });
});

describe("MusicBrainzGate Durable Object", () => {
  const stub = () => env.MUSICBRAINZ_GATE.get(env.MUSICBRAINZ_GATE.idFromName("global"));

  it("hands out start slots MUSICBRAINZ_MIN_INTERVAL_MS apart and refuses an over-long queue", async () => {
    const interval = Number(env.MUSICBRAINZ_MIN_INTERVAL_MS);
    await runInDurableObject(stub(), (instance) => {
      const gate = instance as MusicBrainzGate;
      const t0 = 10_000_000;
      expect(gate.reserve(t0)).toBe(0);
      expect(gate.reserve(t0)).toBe(interval);
      expect(gate.reserve(t0)).toBe(2 * interval);
      const queued = Math.floor(MUSICBRAINZ_MAX_QUEUE_MS / interval);
      for (let i = 3; i <= queued; i += 1) expect(gate.reserve(t0)).toBe(i * interval);
      expect(gate.reserve(t0)).toBeNull();
      // Once time passes, slots free up again.
      expect(gate.reserve(t0 + 60_000)).toBe(0);
    });
  });

  it("serializes concurrent requests from the Worker and sends the MusicBrainz User-Agent", async () => {
    const starts: number[] = [];
    const agents: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      starts.push(Date.now());
      agents.push(new Headers(init?.headers).get("User-Agent") ?? "");
      expect(String(input)).toMatch(/^https:\/\/musicbrainz\.org\/ws\/2\/isrc\//);
      return Response.json({ recordings: [] });
    });
    const budget = new SubrequestBudget(10);
    const gate = createDurableMbGate(env.MUSICBRAINZ_GATE, budget);
    const results = await Promise.all(
      ["A", "B", "C"].map((n) => gate.get(`isrc/USAAA000000${n}?fmt=json`)),
    );
    expect(results.every((res) => res.ok)).toBe(true);
    expect(budget.spent).toBe(3);
    const interval = Number(env.MUSICBRAINZ_MIN_INTERVAL_MS);
    starts.sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(interval - 5);
    }
    expect(new Set(agents)).toEqual(new Set([env.MUSICBRAINZ_USER_AGENT]));
  });

  it("rejects paths outside the MusicBrainz web service shape", async () => {
    const res = await stub().get("https://evil.test/");
    expect(res).toMatchObject({ ok: false, status: 400 });
  });
});
