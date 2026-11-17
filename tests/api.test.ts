import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_MAX_INPUTS } from "../src/config.ts";
import {
  BLINDING_LIGHTS,
  client,
  hit,
  freshStore,
  mockProviders,
  stubMb,
  stubProvider,
  testApp,
} from "./helpers.ts";

async function blindingLightsApp() {
  const db = await freshStore();
  const providers = mockProviders({
    deezer: stubProvider("deezer", {
      byId: { [BLINDING_LIGHTS.ids.deezer]: hit("deezer") },
      byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") },
    }),
    apple: stubProvider("apple", {
      byId: { [BLINDING_LIGHTS.ids.apple]: hit("apple") },
      byIsrc: { [BLINDING_LIGHTS.isrc]: hit("apple") },
    }),
    musicbrainz: stubMb({
      byIsrc: { [BLINDING_LIGHTS.isrc]: hit("musicbrainz") },
      byUrl: {
        "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b": hit("musicbrainz"),
        "https://tidal.com/browse/track/126173746": hit("musicbrainz"),
      },
      relations: [
        {
          platform: "spotify",
          id: BLINDING_LIGHTS.ids.spotify,
          url: BLINDING_LIGHTS.urls.spotify,
        },
        {
          platform: "tidal",
          id: BLINDING_LIGHTS.ids.tidal,
          url: BLINDING_LIGHTS.urls.tidal,
        },
      ],
    }),
  });
  return { api: client(testApp(db, providers)), db, providers };
}

describe("HTTP API", () => {
  it("GET /v1/resolve?isrc= returns recording + platform links", async () => {
    const { api } = await blindingLightsApp();
    const res = await api.get("/v1/resolve", { isrc: BLINDING_LIGHTS.isrc });
    expect(res.status).toBe(200);
    expect(res.body.recording.title).toBe("Blinding Lights");
    expect(Array.isArray(res.body.links)).toBe(true);
    for (const link of res.body.links) {
      expect(link).toHaveProperty("confidence");
      expect(link).toHaveProperty("method");
    }
    expect(res.body.cached).toBe(false);
    expect(res.body.recording_confidence).toBe(0.98);
    expect(res.body.evidence.matching_rule_version).toBeTruthy();
    expect(typeof res.body.evidence.credentials_skipped).toBe("number");
    expect(res.body.evidence.recording_reused).toBe(false);
    expect(res.body.evidence.query_match).toMatchObject({ method: "isrc" });
    expect(Array.isArray(res.body.evidence.destinations)).toBe(true);

    const again = await api.get("/v1/resolve", { isrc: BLINDING_LIGHTS.isrc });
    expect(again.status).toBe(200);
    expect(again.body.cached).toBe(true);
    expect(again.body.recording.id).toBe(res.body.recording.id);
    expect(again.body.evidence.recording_reused).toBe(true);
    expect(again.body.evidence.reuse_via).toBe("input_cache");
  });

  it("resolves Spotify / Apple / Deezer / Tidal ids or URLs to one recording", async () => {
    const { api } = await blindingLightsApp();
    const deezer = await api.get("/v1/resolve", { url: "https://www.deezer.com/track/916424" });
    expect(deezer.status).toBe(200);

    const apple = await api.get("/v1/resolve", { platform: "apple", id: BLINDING_LIGHTS.ids.apple });
    expect(apple.status).toBe(200);
    expect(apple.body.recording.id).toBe(deezer.body.recording.id);

    const spotify = await api.get("/v1/resolve", { url: BLINDING_LIGHTS.urls.spotify });
    expect(spotify.status).toBe(200);
    expect(spotify.body.recording.id).toBe(deezer.body.recording.id);

    const tidal = await api.get("/v1/resolve", { platform: "tidal", id: BLINDING_LIGHTS.ids.tidal });
    expect(tidal.status).toBe(200);
    expect(tidal.body.recording.id).toBe(deezer.body.recording.id);
  });

  it("GET /v1/resolve?artist=&title= returns links when Deezer search matches", async () => {
    const db = await freshStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [hit("deezer")],
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") },
      }),
      apple: stubProvider("apple", {
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("apple") },
      }),
    });
    const api = client(testApp(db, providers));

    const res = await api.get("/v1/resolve", {
      artist: "The Weeknd",
      title: "Blinding Lights",
      duration_ms: 200_040,
    });
    expect(res.status).toBe(200);
    expect(res.body.recording.title).toBe("Blinding Lights");
    expect(res.body.cached).toBe(false);
    expect(typeof res.body.recording_confidence).toBe("number");
    const deezer = res.body.links.find((link: { platform: string }) => link.platform === "deezer");
    expect(deezer).toMatchObject({ unmatched: false, method: "fuzzy" });
    expect(res.body.links.find((link: { platform: string }) => link.platform === "apple")).toMatchObject({
      unmatched: false,
      method: "isrc_from_fuzzy",
    });

    const viaSeconds = await api.get("/v1/resolve", {
      artist: "The Weeknd",
      title: "Blinding Lights",
      duration: 200.04,
    });
    expect(viaSeconds.status).toBe(200);
    expect(viaSeconds.body.cached).toBe(true);
    expect(viaSeconds.body.recording.id).toBe(res.body.recording.id);
  });

  it("GET /v1/resolve artist+title requires duration_ms and 404s when no fuzzy match", async () => {
    const { api } = await blindingLightsApp();
    const missing = await api.get("/v1/resolve", {
      artist: "The Weeknd",
      title: "Blinding Lights",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("bad_request");
    expect(missing.body.error.message).toMatch(/duration_ms is required/);

    const none = await api.get("/v1/resolve", {
      artist: "The Weeknd",
      title: "Blinding Lights",
      duration_ms: 200_040,
    });
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe("not_found");
  });

  it("POST /v1/resolve/batch accepts artist+title items alongside isrc", async () => {
    const db = await freshStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [hit("deezer")],
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") },
      }),
    });
    const api = client(testApp(db, providers));

    const res = await api.post("/v1/resolve/batch", {
        inputs: [
          { artist: "The Weeknd", title: "Blinding Lights", duration_ms: 200_040 },
          { isrc: BLINDING_LIGHTS.isrc },
          { artist: "The Weeknd", title: "Blinding Lights" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(3);
    expect(res.body.results[0].ok).toBe(true);
    expect(res.body.results[0].links.find((link: { platform: string }) => link.platform === "deezer")).toMatchObject({
      method: "fuzzy",
    });
    expect(res.body.results[1].ok).toBe(true);
    expect(res.body.results[2].ok).toBe(false);
    expect(res.body.results[2].error.code).toBe("bad_request");
  });

  it(`POST /v1/resolve/batch accepts up to BATCH_MAX_INPUTS (${DEFAULT_BATCH_MAX_INPUTS}) and rejects one more`, async () => {
    const { api } = await blindingLightsApp();
    const ok = await api.post("/v1/resolve/batch", {
      inputs: Array.from({ length: DEFAULT_BATCH_MAX_INPUTS }, () => ({ isrc: BLINDING_LIGHTS.isrc })),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.results).toHaveLength(DEFAULT_BATCH_MAX_INPUTS);
    expect(ok.body.results.every((item: { ok: boolean }) => item.ok)).toBe(true);

    const tooMany = await api.post("/v1/resolve/batch", {
      inputs: Array.from({ length: DEFAULT_BATCH_MAX_INPUTS + 1 }, () => ({ isrc: BLINDING_LIGHTS.isrc })),
    });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error.code).toBe("bad_request");
  });

  it("POST /v1/resolve/batch defers inputs once the request's subrequest budget is spent", async () => {
    const db = await freshStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", { byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") } }),
    });
    // Room for exactly one resolve: cap 4 + 8 reserved D1 calls = 12.
    const api = client(testApp(db, providers, { subrequestLimit: 12, resolveSubrequestCap: 4 }));
    const res = await api.post("/v1/resolve/batch", {
      inputs: [{ isrc: BLINDING_LIGHTS.isrc }, { isrc: "GBAYE0000001" }, { isrc: "GBAYE0000002" }],
    });
    expect(res.status).toBe(200);
    expect(res.body.results[0].ok).toBe(true);
    for (const item of res.body.results.slice(1)) {
      expect(item).toMatchObject({ ok: false, error: { code: "subrequest_budget_exhausted" } });
    }
  });

  it("answers at the exact path: no trailing-slash redirect, JSON 404 for unknown routes", async () => {
    const { api } = await blindingLightsApp();
    const slash = await api.get("/v1/resolve/", { isrc: BLINDING_LIGHTS.isrc });
    expect(slash.status).toBe(404);
    expect(slash.headers.get("location")).toBeNull();
    expect(slash.body.error.code).toBe("not_found");
    const health = await api.get("/health");
    expect(health).toMatchObject({ status: 200, body: { ok: true, service: "whistle" } });
  });

  it("rejects a malformed JSON batch body with 400", async () => {
    const { api } = await blindingLightsApp();
    const res = await api.post("/v1/resolve/batch", "{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("GET /v1/recordings/:id returns the cached recording", async () => {
    const { api } = await blindingLightsApp();
    const resolved = await api.get("/v1/resolve", { isrc: BLINDING_LIGHTS.isrc });
    const res = await api.get(`/v1/recordings/${resolved.body.recording.id}`);
    expect(res.status).toBe(200);
    expect(res.body.recording.id).toBe(resolved.body.recording.id);
    expect(res.body.cached).toBe(true);
    expect(res.body.recording_confidence).toBe(resolved.body.recording_confidence);
    expect(await api.get("/v1/recordings/does-not-exist")).toMatchObject({ status: 404 });
  });

  it("POST /v1/corrections accepts a wrong-link flag", async () => {
    const { api } = await blindingLightsApp();
    const resolved = await api.get("/v1/resolve", { isrc: BLINDING_LIGHTS.isrc });
    const link = resolved.body.links.find((item: { unmatched: boolean }) => !item.unmatched);
    const res = await api.post("/v1/corrections", { link_id: link.id, reason: "wrong" });
    expect(res.status).toBe(201);
    expect(res.body.correction.reason).toBe("wrong");
    expect(res.body.correction.status).toBe("pending");
    expect(res.body.correction.link_id).toBe(link.id);
  });

  it("POST /v1/corrections accepts a missing-link flag", async () => {
    const { api } = await blindingLightsApp();
    const resolved = await api.get("/v1/resolve", { isrc: BLINDING_LIGHTS.isrc });
    const res = await api.post("/v1/corrections", {
      recording_id: resolved.body.recording.id,
      platform: "ytm",
      reason: "missing",
    });
    expect(res.status).toBe(201);
    expect(res.body.correction.reason).toBe("missing");
    expect(res.body.correction.platform).toBe("ytm");
  });
});
