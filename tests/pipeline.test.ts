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
    expect(byPlatform.deezer.confidence).toBe(0.98);
    expect(byPlatform.apple.method).toBe("isrc");
    expect(byPlatform.apple.confidence).toBe(0.98);
    expect(byPlatform.spotify.method).toBe("mb_relation");
    expect(byPlatform.tidal.unmatched).toBe(true);
    expect(byPlatform.tidal.confidence).toBe(0);
    expect(byPlatform.ytm.unmatched).toBe(true);
    expect(byPlatform.ytm).toHaveProperty("method");
    expect(byPlatform.ytm).toHaveProperty("confidence");
  });

  it("scores a direct platform-id source at 1 and ISRC-only sources at 0.98", async () => {
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        byId: { [BLINDING_LIGHTS.ids.deezer]: hit("deezer") },
      }),
      tidal: stubProvider("tidal", {
        enabled: true,
        byIsrc: { [BLINDING_LIGHTS.isrc]: hit("tidal") },
      }),
    });

    const byId = await resolveTrack(
      { platform: "deezer", id: BLINDING_LIGHTS.ids.deezer },
      { db, providers },
    );
    expect(byId.links.find((l) => l.platform === "deezer")).toMatchObject({
      method: "isrc",
      confidence: 1,
    });

    const tidalOnly = await resolveTrack(
      { isrc: BLINDING_LIGHTS.isrc },
      { db: memoryStore(), providers },
    );
    expect(tidalOnly.links.find((l) => l.platform === "tidal")).toMatchObject({
      method: "isrc",
      confidence: 0.98,
    });
  });

  it("retries sibling ISRCs from MusicBrainz before fuzzy when the primary misses", async () => {
    const primary = "USPRI0000001";
    const sibling = "USSIB0000002";
    const db = memoryStore();
    let deezerSearchCalls = 0;
    const siblingHit = hit("deezer", {
      id: "555",
      url: "https://www.deezer.com/track/555",
      isrc: sibling,
    });
    const providers = mockProviders({
      deezer: {
        ...stubProvider("deezer"),
        async getByIsrc(isrc) {
          return isrc === sibling ? siblingHit : null;
        },
        async search() {
          deezerSearchCalls += 1;
          return [hit("deezer", { id: "999", url: "https://www.deezer.com/track/999" })];
        },
      },
      tidal: stubProvider("tidal", {
        enabled: true,
        byIsrc: { [primary]: hit("tidal", { isrc: primary }) },
      }),
      musicbrainz: stubMb({
        byIsrc: {
          [primary]: hit("musicbrainz", {
            isrc: primary,
            isrcs: [primary, sibling],
          }),
        },
      }),
    });

    const result = await resolveTrack({ isrc: primary }, { db, providers });
    const deezer = result.links.find((l) => l.platform === "deezer")!;
    expect(deezer).toMatchObject({
      unmatched: false,
      method: "isrc",
      confidence: 0.98,
      url: siblingHit.url,
    });
    expect(deezerSearchCalls).toBe(0);
    expect(result.identifiers.some((id) => id.kind === "isrc" && id.value === sibling)).toBe(true);
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

  it("resolves by artist+title via Deezer search and marks the source link fuzzy", async () => {
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

    const result = await resolveTrack(
      { artist: "The Weeknd", title: "Blinding Lights", duration_ms: 200_040 },
      { db, providers },
    );

    expect(result.cached).toBe(false);
    expect(result.recording.title).toBe("Blinding Lights");
    expect(result.identifiers.some((id) => id.kind === "query")).toBe(true);
    expect(result.links.find((l) => l.platform === "deezer")).toMatchObject({
      unmatched: false,
      method: "fuzzy",
      url: BLINDING_LIGHTS.urls.deezer,
    });
    expect(result.links.find((l) => l.platform === "apple")?.method).toBe("isrc");

    const again = await resolveTrack(
      { artist: "the weeknd", title: "blinding lights", duration_ms: 200_040 },
      { db, providers },
    );
    expect(again.cached).toBe(true);
    expect(again.recording.id).toBe(result.recording.id);
  });

  it("bootstraps artist+title+album onto the studio album, not a compilation", async () => {
    const db = memoryStore();
    const studio = hit("deezer", {
      id: "111",
      title: "Ironic",
      artists: ["Alanis Morissette"],
      album: "Jagged Little Pill",
      duration_ms: 230_000,
      isrc: "USMC19500123",
      url: "https://www.deezer.com/track/111",
    });
    const compilation = hit("deezer", {
      id: "222",
      title: "Ironic",
      artists: ["Alanis Morissette"],
      album: "The Collection",
      duration_ms: 230_000,
      isrc: "OTHER00000000",
      url: "https://www.deezer.com/track/222",
    });
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [compilation, studio],
        byIsrc: { [studio.isrc!]: studio },
      }),
    });

    const result = await resolveTrack(
      {
        artist: "Alanis Morissette",
        title: "Ironic",
        album: "Jagged Little Pill",
        duration_ms: 230_000,
      },
      { db, providers },
    );

    expect(result.links.find((l) => l.platform === "deezer")).toMatchObject({
      unmatched: false,
      method: "fuzzy",
      url: studio.url,
    });
  });

  it("rejects artist+title bootstrap when only a remaster or wrong artist is found", async () => {
    const db = memoryStore();
    const remasterProviders = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [
          hit("deezer", {
            title: "Blinding Lights (Remastered)",
            duration_ms: BLINDING_LIGHTS.duration_ms,
          }),
        ],
      }),
    });
    await expect(
      resolveTrack(
        { artist: "The Weeknd", title: "Blinding Lights", duration_ms: 200_040 },
        { db, providers: remasterProviders },
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    const wrongArtist = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [hit("deezer", { artists: ["Someone Else"] })],
      }),
    });
    await expect(
      resolveTrack(
        { artist: "The Weeknd", title: "Blinding Lights", duration_ms: 200_040 },
        { db, providers: wrongArtist },
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
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
