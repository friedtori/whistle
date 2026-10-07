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
  it("rejects wrong-artist destinations in every fuzzy stage, including MusicBrainz and Spotify", async () => {
    const db = memoryStore();
    const wrong = { artists: ["Tribute Band"], isrc: "USWRG0000001" };
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        byId: { [BLINDING_LIGHTS.ids.deezer]: hit("deezer", { isrc: null }) },
      }),
      apple: stubProvider("apple", { searchHits: [hit("apple", wrong)] }),
      tidal: stubProvider("tidal", { searchHits: [hit("tidal", wrong)] }),
      ytm: stubProvider("ytm", { searchHits: [hit("ytm", wrong)] }),
      spotify: stubProvider("spotify", { searchHits: [hit("spotify", wrong)] }),
      musicbrainz: stubMb({ searchHits: [hit("musicbrainz", wrong)] }),
    });
    try {
      const result = await resolveTrack(
        { platform: "deezer", id: BLINDING_LIGHTS.ids.deezer }, { db, providers },
      );
      expect(result.links.filter((link) => !link.unmatched).map((link) => link.platform)).toEqual(["deezer"]);
      expect(result.identifiers.some((id) => id.kind === "isrc")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("retries search when the strict results contain only a wrong performer", async () => {
    const db = memoryStore();
    const { searchWithPlainFallback } = await import("../src/providers/search.ts");
    const calls: string[] = [];
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        byId: { [BLINDING_LIGHTS.ids.deezer]: hit("deezer", { isrc: null }) },
      }),
      apple: {
        ...stubProvider("apple"),
        async search(query) {
          return searchWithPlainFallback(query, "strict", async (q) => {
            calls.push(q);
            return [q === "strict" ? hit("apple", { artists: ["Tribute Band"] }) : hit("apple")];
          });
        },
      },
    });
    try {
      const result = await resolveTrack(
        { platform: "deezer", id: BLINDING_LIGHTS.ids.deezer }, { db, providers },
      );
      expect(calls).toEqual(["strict", "The Weeknd Blinding Lights"]);
      expect(result.links.find((link) => link.platform === "apple")).toMatchObject({ unmatched: false, method: "fuzzy" });
    } finally {
      db.close();
    }
  });

  it("bootstraps non-Latin metadata and rejects unrelated equal-duration titles", async () => {
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", { searchHits: [
        hit("deezer", { title: "別の曲", artists: ["宇多田ヒカル"], isrc: null }),
        hit("deezer", { id: "123", title: "光", artists: ["宇多田ヒカル"], isrc: null }),
      ] }),
    });
    try {
      const result = await resolveTrack(
        { artist: "宇多田ヒカル", title: "光", duration_ms: BLINDING_LIGHTS.duration_ms }, { db, providers },
      );
      expect(result.recording.title).toBe("光");
      expect(result.identifiers).toContainEqual({ kind: "deezer", value: "123" });
    } finally {
      db.close();
    }
  });

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

  it("does not launder fuzzy MusicBrainz ISRCs into 0.98 isrc matches", async () => {
    const trusted = "USTRT0000001";
    const poisoned = "USPOI0000002";
    const tried: string[] = [];
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        byId: { [BLINDING_LIGHTS.ids.deezer]: hit("deezer", { isrc: trusted }) },
      }),
      apple: {
        ...stubProvider("apple"),
        async getByIsrc(isrc) {
          tried.push(`apple:${isrc}`);
          return isrc === poisoned
            ? hit("apple", { id: "bad", url: "https://music.apple.com/us/song/bad", isrc: poisoned })
            : null;
        },
      },
      musicbrainz: stubMb({
        searchHits: [
          hit("musicbrainz", {
            id: "mb-wrong",
            mbid: "mb-wrong",
            isrc: poisoned,
            isrcs: [poisoned],
          }),
        ],
      }),
    });

    const result = await resolveTrack(
      { url: "https://www.deezer.com/track/916424" },
      { db: memoryStore(), providers },
    );

    const apple = result.links.find((l) => l.platform === "apple")!;
    expect(apple).toMatchObject({
      unmatched: false,
      method: "isrc_from_fuzzy",
      confidence: 0.8 * 0.98,
    });
    expect(result.identifiers.some((id) => id.kind === "isrc" && id.value === trusted)).toBe(true);
    expect(result.identifiers.some((id) => id.kind === "isrc" && id.value === poisoned)).toBe(false);
    expect(tried.filter((key) => key === "apple:USTRT0000001")).toHaveLength(1);
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
    expect(result.links.find((l) => l.platform === "apple")).toMatchObject({
      method: "isrc_from_fuzzy",
      confidence: 0.8 * 0.98,
    });

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
