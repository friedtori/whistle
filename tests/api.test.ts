import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import {
  BLINDING_LIGHTS,
  hit,
  memoryStore,
  mockProviders,
  stubMb,
  stubProvider,
} from "./helpers.ts";

function testApp() {
  const db = memoryStore();
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
  return { app: createApp({ db, providers }), db, providers };
}

describe("HTTP API", () => {
  it("GET /v1/resolve?isrc= returns recording + platform links", async () => {
    const { app } = testApp();
    const res = await request(app).get("/v1/resolve").query({ isrc: BLINDING_LIGHTS.isrc });
    expect(res.status).toBe(200);
    expect(res.body.recording.title).toBe("Blinding Lights");
    expect(Array.isArray(res.body.links)).toBe(true);
    for (const link of res.body.links) {
      expect(link).toHaveProperty("confidence");
      expect(link).toHaveProperty("method");
    }
    expect(res.body.cached).toBe(false);
    expect(res.body.recording_confidence).toBe(0.98);

    const again = await request(app).get("/v1/resolve").query({ isrc: BLINDING_LIGHTS.isrc });
    expect(again.status).toBe(200);
    expect(again.body.cached).toBe(true);
    expect(again.body.recording.id).toBe(res.body.recording.id);
  });

  it("resolves Spotify / Apple / Deezer / Tidal ids or URLs to one recording", async () => {
    const { app } = testApp();
    const deezer = await request(app)
      .get("/v1/resolve")
      .query({ url: "https://www.deezer.com/track/916424" });
    expect(deezer.status).toBe(200);

    const apple = await request(app)
      .get("/v1/resolve")
      .query({ platform: "apple", id: BLINDING_LIGHTS.ids.apple });
    expect(apple.status).toBe(200);
    expect(apple.body.recording.id).toBe(deezer.body.recording.id);

    const spotify = await request(app)
      .get("/v1/resolve")
      .query({ url: BLINDING_LIGHTS.urls.spotify });
    expect(spotify.status).toBe(200);
    expect(spotify.body.recording.id).toBe(deezer.body.recording.id);

    const tidal = await request(app)
      .get("/v1/resolve")
      .query({ platform: "tidal", id: BLINDING_LIGHTS.ids.tidal });
    expect(tidal.status).toBe(200);
    expect(tidal.body.recording.id).toBe(deezer.body.recording.id);
  });

  it("GET /v1/resolve?artist=&title= returns links when Deezer search matches", async () => {
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [hit("deezer")],
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") },
      }),
      apple: stubProvider("apple", {
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("apple") },
      }),
    });
    const app = createApp({ db, providers });

    const res = await request(app).get("/v1/resolve").query({
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

    const viaSeconds = await request(app).get("/v1/resolve").query({
      artist: "The Weeknd",
      title: "Blinding Lights",
      duration: 200.04,
    });
    expect(viaSeconds.status).toBe(200);
    expect(viaSeconds.body.cached).toBe(true);
    expect(viaSeconds.body.recording.id).toBe(res.body.recording.id);
  });

  it("GET /v1/resolve artist+title requires duration_ms and 404s when no fuzzy match", async () => {
    const { app } = testApp();
    const missing = await request(app).get("/v1/resolve").query({
      artist: "The Weeknd",
      title: "Blinding Lights",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("bad_request");
    expect(missing.body.error.message).toMatch(/duration_ms is required/);

    const none = await request(app).get("/v1/resolve").query({
      artist: "The Weeknd",
      title: "Blinding Lights",
      duration_ms: 200_040,
    });
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe("not_found");
  });

  it("POST /v1/resolve/batch accepts artist+title items alongside isrc", async () => {
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [hit("deezer")],
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") },
      }),
    });
    const app = createApp({ db, providers });

    const res = await request(app)
      .post("/v1/resolve/batch")
      .send({
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

  it("POST /v1/resolve/batch accepts up to 100 inputs and rejects 101", async () => {
    const { app } = testApp();
    const ok = await request(app)
      .post("/v1/resolve/batch")
      .send({ inputs: [{ isrc: BLINDING_LIGHTS.isrc }, { url: BLINDING_LIGHTS.urls.deezer }] });
    expect(ok.status).toBe(200);
    expect(ok.body.results).toHaveLength(2);
    expect(ok.body.results[0].ok).toBe(true);

    const tooMany = await request(app)
      .post("/v1/resolve/batch")
      .send({ inputs: Array.from({ length: 101 }, () => ({ isrc: BLINDING_LIGHTS.isrc })) });
    expect(tooMany.status).toBe(400);
  });

  it("GET /v1/recordings/:id returns the cached recording", async () => {
    const { app } = testApp();
    const resolved = await request(app).get("/v1/resolve").query({ isrc: BLINDING_LIGHTS.isrc });
    const res = await request(app).get(`/v1/recordings/${resolved.body.recording.id}`);
    expect(res.status).toBe(200);
    expect(res.body.recording.id).toBe(resolved.body.recording.id);
    expect(res.body.cached).toBe(true);
    expect(res.body.recording_confidence).toBe(resolved.body.recording_confidence);
    expect(await request(app).get("/v1/recordings/does-not-exist")).toMatchObject({ status: 404 });
  });

  it("POST /v1/corrections accepts a wrong-link flag", async () => {
    const { app } = testApp();
    const resolved = await request(app).get("/v1/resolve").query({ isrc: BLINDING_LIGHTS.isrc });
    const link = resolved.body.links.find((item: { unmatched: boolean }) => !item.unmatched);
    const res = await request(app)
      .post("/v1/corrections")
      .send({ link_id: link.id, reason: "wrong" });
    expect(res.status).toBe(201);
    expect(res.body.correction.reason).toBe("wrong");
    expect(res.body.correction.status).toBe("pending");
    expect(res.body.correction.link_id).toBe(link.id);
  });

  it("POST /v1/corrections accepts a missing-link flag", async () => {
    const { app } = testApp();
    const resolved = await request(app).get("/v1/resolve").query({ isrc: BLINDING_LIGHTS.isrc });
    const res = await request(app).post("/v1/corrections").send({
      recording_id: resolved.body.recording.id,
      platform: "ytm",
      reason: "missing",
    });
    expect(res.status).toBe(201);
    expect(res.body.correction.reason).toBe("missing");
    expect(res.body.correction.platform).toBe("ytm");
  });
});
