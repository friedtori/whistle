import { describe, expect, it } from "vitest";
import { resolveTrack } from "../src/pipeline.ts";
import {
  BLINDING_LIGHTS,
  hit,
  memoryStore,
  mockProviders,
  stubMb,
  stubProvider,
} from "./helpers.ts";

describe("resolution pipeline", () => {
  it("resolves by ISRC and returns confidence + method for each v1 platform", async () => {
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") },
      }),
      apple: stubProvider("apple", {
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("apple") },
      }),
      musicbrainz: stubMb({
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("musicbrainz") },
        relations: [
          {
            platform: "spotify",
            id: BLINDING_LIGHTS.ids.spotify,
            url: BLINDING_LIGHTS.urls.spotify,
          },
        ],
      }),
    });

    const result = await resolveTrack({ isrc: BLINDING_LIGHTS.isrc }, { db, providers });

    expect(result.cached).toBe(false);
    expect(result.recording.title).toBe("Blinding Lights");
    expect(result.recording.artists).toContain("The Weeknd");
    expect(result.identifiers.some((id) => id.kind === "isrc" && id.value === BLINDING_LIGHTS.isrc)).toBe(
      true,
    );

    const byPlatform = Object.fromEntries(result.links.map((link) => [link.platform, link]));
    expect(byPlatform.deezer).toMatchObject({
      unmatched: false,
      method: "isrc",
      url: BLINDING_LIGHTS.urls.deezer,
    });
    expect(byPlatform.deezer.confidence).toBeGreaterThan(0);
    expect(byPlatform.apple.method).toBe("isrc");
    expect(byPlatform.spotify.method).toBe("mb_relation");
    expect(byPlatform.tidal.unmatched).toBe(true);
    expect(byPlatform.tidal.confidence).toBe(0);
    expect(byPlatform.ytm.unmatched).toBe(true);
    expect(byPlatform.ytm).toHaveProperty("method");
    expect(byPlatform.ytm).toHaveProperty("confidence");
  });

  it("normalizes a Deezer URL to a recording and fills other platforms", async () => {
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        byId: { [BLINDING_LIGHTS.ids.deezer]: hit("deezer") },
      }),
      apple: stubProvider("apple", {
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("apple") },
      }),
      musicbrainz: stubMb({
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("musicbrainz") },
      }),
    });

    const result = await resolveTrack(
      { url: "https://www.deezer.com/track/916424" },
      { db, providers },
    );
    expect(result.recording.title).toBe("Blinding Lights");
    expect(result.links.find((l) => l.platform === "apple")?.method).toBe("isrc");
    expect(result.links.find((l) => l.platform === "deezer")?.unmatched).toBe(false);
  });

  it("does not overwrite an ISRC match with a later fuzzy hit", async () => {
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") },
        searchHits: [hit("deezer", { id: "999", url: "https://www.deezer.com/track/999" })],
      }),
      apple: stubProvider("apple", {
        searchHits: [hit("apple")],
      }),
    });

    const result = await resolveTrack({ isrc: BLINDING_LIGHTS.isrc }, { db, providers });
    const deezer = result.links.find((l) => l.platform === "deezer")!;
    expect(deezer.method).toBe("isrc");
    expect(deezer.url).toBe(BLINDING_LIGHTS.urls.deezer);
    expect(result.links.find((l) => l.platform === "apple")?.method).toBe("fuzzy");
  });

  it("leaves a platform unmatched when fuzzy hits a conflicting live version", async () => {
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") },
      }),
      apple: stubProvider("apple", {
        searchHits: [
          hit("apple", {
            title: "Blinding Lights (Live)",
            duration_ms: BLINDING_LIGHTS.duration_ms,
          }),
        ],
      }),
    });

    const result = await resolveTrack({ isrc: BLINDING_LIGHTS.isrc }, { db, providers });
    const apple = result.links.find((l) => l.platform === "apple")!;
    expect(apple.unmatched).toBe(true);
    expect(apple.url).toBeNull();
    expect(apple.confidence).toBe(0);
  });

  it("returns a cache hit on repeat resolve of the same input", async () => {
    const db = memoryStore();
    let isrcCalls = 0;
    const providers = mockProviders({
      deezer: {
        ...stubProvider("deezer"),
        async getByIsrc(isrc) {
          isrcCalls += 1;
          return isrc === BLINDING_LIGHTS.isrc ? hit("deezer") : null;
        },
      },
    });

    const first = await resolveTrack({ isrc: BLINDING_LIGHTS.isrc }, { db, providers });
    const second = await resolveTrack({ isrc: BLINDING_LIGHTS.isrc }, { db, providers });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.recording.id).toBe(first.recording.id);
    expect(isrcCalls).toBe(1);
  });

  it("resolves Spotify last via title search and never uses it to seed earlier platforms", async () => {
    const order: string[] = [];
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("deezer") },
      }),
      spotify: {
        platform: "spotify",
        enabled: true,
        supportsIsrcLookup: true,
        async getById() {
          return null;
        },
        async getByIsrc() {
          order.push("spotify-isrc");
          return null;
        },
        async search() {
          order.push("spotify-search");
          return [hit("spotify")];
        },
      },
    });

    const result = await resolveTrack({ isrc: BLINDING_LIGHTS.isrc }, { db, providers });
    expect(order[order.length - 1]).toBe("spotify-search");
    expect(result.links.find((l) => l.platform === "spotify")?.method).toBe("fuzzy");
  });
});
