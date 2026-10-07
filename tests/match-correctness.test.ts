import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateFuzzy, titleSimilarity } from "../src/fuzzy.ts";
import { resolveTrack } from "../src/pipeline.ts";
import { MATCHING_RULE_VERSION } from "../src/types.ts";
import { hit, memoryStore, mockProviders, stubProvider } from "./helpers.ts";

const named = JSON.parse(
  readFileSync(new URL("./fixtures/seed-archive/named-cases.json", import.meta.url), "utf8"),
) as {
  fuzzy_identity_conflicts: Array<{ input_key: string }>;
  version_review: Array<{ input_key: string }>;
  wild_storm_seed: { isrc: string };
};

function expectInputKey(key: string) {
  const known = [
    ...named.fuzzy_identity_conflicts.map((row) => row.input_key),
    ...named.version_review.map((row) => row.input_key),
  ];
  expect(known).toContain(key);
}

const WILD_STORM = {
  isrc: named.wild_storm_seed.isrc as "QM24S2602823",
  title: "Wild Storm",
  artists: ["Empress Of"],
  duration_ms: 167_000,
  appleUrl: "https://music.apple.com/us/song/6782918578",
  deezerUrl: "https://www.deezer.com/track/4022342901",
};

const BILLY = {
  title: "Billy Came Back",
  artists: ["This Is Lorelei"],
  duration_ms: 189_000,
  appleUrl: "https://music.apple.com/us/song/6774172446",
  tidalUrl: "https://tidal.com/browse/track/554024753",
  spotifyUrl: "https://open.spotify.com/track/3ugz7wYrIltNprCU6SsVJR",
};

const NWCBF = {
  title: "Now We Can't Be Friends",
  artists: ["Bloc Party"],
  duration_ms: 210_000,
  appleUrl: "https://music.apple.com/us/album/now-we-cant-be-friends/1895408368?i=6763631016",
  tidalUrl: "https://tidal.com/browse/track/558620915",
};

describe("named archive identity cases", () => {
  it("Oh No Now My → only Billy Came Back → 404, and still 404 after Billy is seeded", async () => {
    expectInputKey("this is lorelei\toh no now my\toh no now my\t188000");
    const billyHit = hit("deezer", {
      id: "billy",
      title: BILLY.title,
      artists: BILLY.artists,
      duration_ms: BILLY.duration_ms,
      isrc: "USLORELEI001",
      url: "https://www.deezer.com/track/billy",
    });
    const appleBilly = hit("apple", {
      id: "6774172446",
      title: BILLY.title,
      artists: BILLY.artists,
      duration_ms: BILLY.duration_ms,
      url: BILLY.appleUrl,
    });
    const tidalBilly = hit("tidal", {
      id: "554024753",
      title: BILLY.title,
      artists: BILLY.artists,
      duration_ms: BILLY.duration_ms,
      url: BILLY.tidalUrl,
    });

    await expect(
      resolveTrack(
        { artist: "This Is Lorelei", title: "Oh No Now My", album: "Oh No Now My", duration_ms: 188_000 },
        {
          db: memoryStore(),
          providers: mockProviders({
            deezer: stubProvider("deezer", { searchHits: [billyHit] }),
          }),
        },
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [billyHit],
        byIsrc: { [billyHit.isrc!]: billyHit },
      }),
      apple: stubProvider("apple", { searchHits: [appleBilly] }),
      tidal: stubProvider("tidal", { enabled: true, searchHits: [tidalBilly] }),
    });
    const seeded = await resolveTrack(
      { artist: "This Is Lorelei", title: "Billy Came Back", album: "Oh No Now My", duration_ms: 189_000 },
      { db, providers },
    );
    expect(seeded.recording.title).toBe("Billy Came Back");
    expect(seeded.links.some((link) => link.url === BILLY.appleUrl)).toBe(true);

    await expect(
      resolveTrack(
        { artist: "This Is Lorelei", title: "Oh No Now My", album: "Oh No Now My", duration_ms: 188_000 },
        { db, providers },
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    const billyAgain = await resolveTrack(
      { artist: "This Is Lorelei", title: "Billy Came Back", album: "Oh No Now My", duration_ms: 189_000 },
      { db, providers },
    );
    expect(billyAgain.recording.id).toBe(seeded.recording.id);
    expect(billyAgain.identifiers.some((id) => id.kind === "query" && id.value.includes("oh no now my") && !id.value.includes("billy"))).toBe(
      false,
    );
  });

  it("SYW → only Wild Storm → 404; after ISRC-seeded Wild Storm still 404 without inherited links", async () => {
    expectInputKey("empress of\tsyw (feat. cecile believe)\tsyw (feat. cecile believe)\t167000");
    const wild = hit("deezer", {
      id: "wild-dz",
      title: WILD_STORM.title,
      artists: WILD_STORM.artists,
      duration_ms: WILD_STORM.duration_ms,
      isrc: WILD_STORM.isrc,
      url: WILD_STORM.deezerUrl,
    });
    const wildApple = hit("apple", {
      id: "6782918578",
      title: WILD_STORM.title,
      artists: WILD_STORM.artists,
      duration_ms: WILD_STORM.duration_ms,
      isrc: WILD_STORM.isrc,
      url: WILD_STORM.appleUrl,
    });

    await expect(
      resolveTrack(
        {
          artist: "Empress Of",
          title: "SYW (feat. Cecile Believe)",
          album: "SYW (feat. Cecile Believe)",
          duration_ms: 167_000,
        },
        {
          db: memoryStore(),
          providers: mockProviders({
            deezer: stubProvider("deezer", { searchHits: [wild] }),
          }),
        },
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [wild],
        byIsrc: { [WILD_STORM.isrc]: wild },
      }),
      apple: stubProvider("apple", { byIsrc: { [WILD_STORM.isrc]: wildApple } }),
    });
    const seeded = await resolveTrack({ isrc: WILD_STORM.isrc }, { db, providers });
    expect(seeded.recording.title).toBe("Wild Storm");

    await expect(
      resolveTrack(
        {
          artist: "Empress Of",
          title: "SYW (feat. Cecile Believe)",
          album: "SYW (feat. Cecile Believe)",
          duration_ms: 167_000,
        },
        { db, providers },
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(seeded.identifiers.some((id) => id.kind === "query" && id.value.includes("syw"))).toBe(false);
    const wildAgain = await resolveTrack({ isrc: WILD_STORM.isrc }, { db, providers });
    expect(wildAgain.recording.id).toBe(seeded.recording.id);
    expect(wildAgain.recording.title).toBe("Wild Storm");
    expect(wildAgain.links.find((link) => link.platform === "apple")?.url).toBe(WILD_STORM.appleUrl);
  });

  it("does not coalesce a SYW-titled hit that carries Wild Storm's ISRC onto Wild Storm", async () => {
    const wild = hit("deezer", {
      id: "wild-dz",
      title: WILD_STORM.title,
      artists: WILD_STORM.artists,
      duration_ms: WILD_STORM.duration_ms,
      isrc: WILD_STORM.isrc,
      url: WILD_STORM.deezerUrl,
    });
    const wildApple = hit("apple", {
      id: "6782918578",
      title: WILD_STORM.title,
      artists: WILD_STORM.artists,
      duration_ms: WILD_STORM.duration_ms,
      isrc: WILD_STORM.isrc,
      url: WILD_STORM.appleUrl,
    });
    const syw = hit("deezer", {
      id: "syw-dz",
      title: "SYW (feat. Cecile Believe)",
      artists: ["Empress Of"],
      duration_ms: 167_000,
      isrc: WILD_STORM.isrc,
      url: "https://www.deezer.com/track/syw",
    });
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [syw],
        byIsrc: { [WILD_STORM.isrc]: wild },
      }),
      apple: stubProvider("apple", { byIsrc: { [WILD_STORM.isrc]: wildApple } }),
    });
    const seeded = await resolveTrack({ isrc: WILD_STORM.isrc }, { db, providers });
    expect(seeded.recording.title).toBe("Wild Storm");

    const sywResult = await resolveTrack(
      {
        artist: "Empress Of",
        title: "SYW (feat. Cecile Believe)",
        album: "SYW (feat. Cecile Believe)",
        duration_ms: 167_000,
      },
      { db, providers },
    );
    expect(sywResult.recording.id).not.toBe(seeded.recording.id);
    expect(sywResult.recording.title).toMatch(/SYW/i);
    expect(sywResult.evidence.recording_reused).toBe(false);
    expect(sywResult.links.find((link) => link.platform === "deezer")?.url).toBe(syw.url);
    expect(sywResult.links.find((link) => link.platform === "apple")?.url).not.toBe(WILD_STORM.appleUrl);
    expect(sywResult.links.find((link) => link.platform === "apple")?.skip_reason).toBe("destination_mismatch");

    const wildAgain = await resolveTrack({ isrc: WILD_STORM.isrc }, { db, providers });
    expect(wildAgain.recording.id).toBe(seeded.recording.id);
    expect(wildAgain.recording.title).toBe("Wild Storm");
    expect(wildAgain.identifiers.some((id) => id.kind === "query" && id.value.includes("syw"))).toBe(false);
  });

  it("HandsOn after Wild Storm is seeded still 404s and does not inherit Wild Storm URLs", async () => {
    expectInputKey("empress of\thandson\thandson\t169000");
    const wild = hit("deezer", {
      id: "wild-dz",
      title: WILD_STORM.title,
      artists: WILD_STORM.artists,
      duration_ms: 169_000,
      isrc: WILD_STORM.isrc,
      url: WILD_STORM.deezerUrl,
    });
    const wildApple = hit("apple", {
      id: "6782918578",
      title: WILD_STORM.title,
      artists: WILD_STORM.artists,
      duration_ms: 169_000,
      isrc: WILD_STORM.isrc,
      url: WILD_STORM.appleUrl,
    });
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [wild],
        byIsrc: { [WILD_STORM.isrc]: wild },
      }),
      apple: stubProvider("apple", { byIsrc: { [WILD_STORM.isrc]: wildApple } }),
    });
    const seeded = await resolveTrack({ isrc: WILD_STORM.isrc }, { db, providers });
    expect(seeded.recording.title).toBe("Wild Storm");

    await expect(
      resolveTrack(
        { artist: "Empress Of", title: "HandsOn", album: "HandsOn", duration_ms: 169_000 },
        { db, providers },
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(seeded.identifiers.some((id) => id.kind === "query" && id.value.includes("handson"))).toBe(false);
    expect((await resolveTrack({ isrc: WILD_STORM.isrc }, { db, providers })).recording.id).toBe(seeded.recording.id);
  });

  it("Pigwig after Now We Can't Be Friends is seeded still 404s without shared Apple/Tidal URLs", async () => {
    expectInputKey("bloc party\tpigwig\tpigwig\t210000");
    const friends = hit("deezer", {
      id: "friends-dz",
      title: NWCBF.title,
      artists: NWCBF.artists,
      duration_ms: NWCBF.duration_ms,
      isrc: "GBNWC0000001",
      url: "https://www.deezer.com/track/friends",
    });
    const friendsApple = hit("apple", {
      id: "6763631016",
      title: NWCBF.title,
      artists: NWCBF.artists,
      duration_ms: NWCBF.duration_ms,
      url: NWCBF.appleUrl,
    });
    const friendsTidal = hit("tidal", {
      id: "558620915",
      title: NWCBF.title,
      artists: NWCBF.artists,
      duration_ms: NWCBF.duration_ms,
      url: NWCBF.tidalUrl,
    });
    const db = memoryStore();
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [friends],
        byIsrc: { [friends.isrc!]: friends },
      }),
      apple: stubProvider("apple", { searchHits: [friendsApple] }),
      tidal: stubProvider("tidal", { enabled: true, searchHits: [friendsTidal] }),
    });
    const seeded = await resolveTrack(
      { artist: "Bloc Party", title: "Now We Can't Be Friends", album: "Now We Can't Be Friends", duration_ms: 210_000 },
      { db, providers },
    );
    expect(seeded.recording.title).toBe("Now We Can't Be Friends");
    expect(seeded.links.some((link) => link.url === NWCBF.appleUrl || link.url === NWCBF.tidalUrl)).toBe(true);

    await expect(
      resolveTrack(
        { artist: "Bloc Party", title: "Pigwig", album: "Pigwig", duration_ms: 210_000 },
        { db, providers },
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(seeded.identifiers.some((id) => id.kind === "query" && id.value.includes("pigwig"))).toBe(false);
    expect(
      (await resolveTrack(
        { artist: "Bloc Party", title: "Now We Can't Be Friends", album: "Now We Can't Be Friends", duration_ms: 210_000 },
        { db, providers },
      )).recording.id,
    ).toBe(seeded.recording.id);
  });

  it("404s Dexter vs Nord at the archive duration 549000", async () => {
    expectInputKey("ricardo villalobos\tdexter\tdexter\t549000");
    await expect(
      resolveTrack(
        { artist: "Ricardo Villalobos", title: "Dexter", album: "Dexter", duration_ms: 549_000 },
        {
          db: memoryStore(),
          providers: mockProviders({
            deezer: stubProvider("deezer", {
              searchHits: [
                hit("deezer", {
                  title: "Nord",
                  artists: ["Ricardo Villalobos"],
                  duration_ms: 549_000,
                }),
              ],
            }),
          }),
        },
      ),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("Apple destination URL/album version leaks", () => {
  const cases = [
    {
      isrc: "JPPO00605880",
      sourceTitle: "Kibun Jou Jou",
      sourceArtists: ["mihimaru GT"],
      appleTitle: "Kibun Jou Jou",
      appleArtists: ["Harusaruhi"],
      appleAlbum: "Kibun Jou Jou (Cover)",
      appleUrl: "https://music.apple.com/us/album/kibun-jou-jou-cover/1709945211?i=1709945229&uo=4",
    },
    {
      isrc: "USUM71405403",
      sourceTitle: "Problem",
      sourceArtists: ["Ariana Grande"],
      appleTitle: "Problem",
      appleArtists: ["Ariana Grande"],
      appleAlbum: "Problem (Instrumental)",
      appleUrl: "https://music.apple.com/us/album/problem-instrumental/1764322879?i=1764322886&uo=4",
    },
    {
      isrc: "USUM71809768",
      sourceTitle: "UDK",
      sourceArtists: ["Olivia O'Brien"],
      appleTitle: "UDK",
      appleArtists: ["Olivia O'Brien"],
      appleAlbum: "UDK (Acoustic)",
      appleUrl: "https://music.apple.com/us/album/udk-acoustic/1428922915?i=1428923801&uo=4",
    },
    {
      isrc: "USSM12402705",
      sourceTitle: "BLACKBIIRD",
      sourceArtists: ["Beyoncé"],
      appleTitle: "BLACKBIIRD",
      appleArtists: ["Beyoncé"],
      appleAlbum: "Cowboy Carter Karaoke",
      appleUrl:
        "https://music.apple.com/us/album/blackbiird-karaoke-version-originally-performed-by/1742094069?i=1742094073&uo=4",
    },
    {
      isrc: "USUM71819361",
      sourceTitle: "thank u, next",
      sourceArtists: ["Ariana Grande"],
      appleTitle: "thank u, next",
      appleArtists: ["Ariana Grande"],
      appleAlbum: "thank u, next (instrumental)",
      appleUrl: "https://music.apple.com/us/album/thank-u-next-instrumental/1453077778?i=1453077791&uo=4",
    },
  ];

  for (const row of cases) {
    it(`leaves Apple unmatched for ${row.sourceTitle} when URL/album names a version`, async () => {
      const duration_ms = 200_000;
      const deezerHit = hit("deezer", {
        id: `${row.isrc}-dz`,
        title: row.sourceTitle,
        artists: row.sourceArtists,
        duration_ms,
        isrc: row.isrc,
        url: `https://www.deezer.com/track/${row.isrc}`,
      });
      const appleHit = hit("apple", {
        id: "leaky-apple",
        title: row.appleTitle,
        artists: row.appleArtists,
        duration_ms,
        album: row.appleAlbum,
        url: row.appleUrl,
        isrc: null,
      });
      const result = await resolveTrack(
        { isrc: row.isrc },
        {
          db: memoryStore(),
          providers: mockProviders({
            deezer: stubProvider("deezer", { byIsrc: { [row.isrc]: deezerHit } }),
            apple: stubProvider("apple", { searchHits: [appleHit] }),
          }),
        },
      );
      expect(result.recording.title).toBe(row.sourceTitle);
      expect(result.recording.artists).toEqual(row.sourceArtists);
      expect(result.links.find((link) => link.platform === "apple")).toMatchObject({
        unmatched: true,
        url: null,
        skip_reason: "destination_mismatch",
      });
      const appleDest = result.evidence.destinations.find((dest) => dest.platform === "apple");
      expect(appleDest).toMatchObject({ accepted: false, reason: "destination_mismatch" });
    });
  }

  it("rejects an ISRC-stage Apple hop whose version lives only in album+URL", async () => {
    const duration_ms = 200_000;
    const deezerHit = hit("deezer", {
      id: "problem-dz",
      title: "Problem",
      artists: ["Ariana Grande"],
      duration_ms,
      isrc: "USUM71405403",
      url: "https://www.deezer.com/track/problem",
    });
    const appleHit = hit("apple", {
      id: "1764322886",
      title: "Problem",
      artists: ["Ariana Grande"],
      duration_ms,
      album: "Problem (Instrumental)",
      url: "https://music.apple.com/us/album/problem-instrumental/1764322879?i=1764322886&uo=4",
      isrc: "USUM71405403",
    });
    const result = await resolveTrack(
      { isrc: "USUM71405403" },
      {
        db: memoryStore(),
        providers: mockProviders({
          deezer: stubProvider("deezer", { byIsrc: { USUM71405403: deezerHit } }),
          apple: stubProvider("apple", { byIsrc: { USUM71405403: appleHit } }),
        }),
      },
    );
    expect(result.recording.title).toBe("Problem");
    expect(result.links.find((link) => link.platform === "apple")).toMatchObject({
      unmatched: true,
      skip_reason: "destination_mismatch",
    });
  });
});

describe("archive thicc + Midnight Sun", () => {
  it("archive thicc: title=thicc + remix album vs acapella 404, remix accept, both → remix", async () => {
    expectInputKey("shygirl\tthicc\tthicc (fedde le grand remix)\t223000");
    const duration_ms = 223_000;
    const query = {
      artist: "Shygirl",
      title: "thicc",
      album: "thicc (Fedde Le Grand remix)",
      duration_ms,
    };
    const acapella = hit("deezer", {
      id: "thicc-acapella",
      title: "thicc (acapella)",
      artists: ["Shygirl"],
      duration_ms,
      isrc: null,
      url: "https://www.deezer.com/track/thicc-acapella",
    });
    const remix = hit("deezer", {
      id: "thicc-remix",
      title: "thicc (Fedde Le Grand remix)",
      artists: ["Shygirl"],
      album: "thicc (Fedde Le Grand remix)",
      duration_ms,
      isrc: null,
      url: "https://www.deezer.com/track/thicc-remix",
    });

    await expect(
      resolveTrack(query, {
        db: memoryStore(),
        providers: mockProviders({ deezer: stubProvider("deezer", { searchHits: [acapella] }) }),
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });

    const accepted = await resolveTrack(query, {
      db: memoryStore(),
      providers: mockProviders({ deezer: stubProvider("deezer", { searchHits: [remix] }) }),
    });
    expect(accepted.recording.title).toBe("thicc (Fedde Le Grand remix)");
    expect(accepted.links.find((link) => link.platform === "deezer")?.url).toBe(remix.url);

    const both = await resolveTrack(query, {
      db: memoryStore(),
      providers: mockProviders({ deezer: stubProvider("deezer", { searchHits: [acapella, remix] }) }),
    });
    expect(both.recording.title).toBe("thicc (Fedde Le Grand remix)");
    expect(both.links.find((link) => link.platform === "deezer")?.url).toBe(remix.url);
    expect(both.links.find((link) => link.platform === "deezer")?.url).not.toBe(acapella.url);
  });

  it("Midnight Sun vs only Super Loud is version-review (paren-stripped identity may accept)", async () => {
    // Version-review: Super Loud is not a known version family. Current acceptable
    // behavior is either accept Super Loud (paren-stripped identity) OR unmatched
    // if a conservative paren guard is added later. Prefer bare “Midnight Sun”
    // when both exist. Do not hard-404 if Super Loud is the only duration-valid hit.
    expectInputKey("zara larsson\tmidnight sun\tmidnight sun\t190000");
    const duration_ms = 190_000;
    const superLoud = hit("deezer", {
      id: "super-loud",
      title: "Midnight Sun (Super Loud)",
      artists: ["Zara Larsson"],
      album: "Midnight Sun (Super Loud)",
      duration_ms,
      isrc: null,
      url: "https://www.deezer.com/track/super-loud",
    });
    const bare = hit("deezer", {
      id: "bare-ms",
      title: "Midnight Sun",
      artists: ["Zara Larsson"],
      album: "Midnight Sun",
      duration_ms,
      isrc: null,
      url: "https://www.deezer.com/track/midnight-sun",
    });

    const onlyLoud = await resolveTrack(
      { artist: "Zara Larsson", title: "Midnight Sun", album: "Midnight Sun", duration_ms },
      {
        db: memoryStore(),
        providers: mockProviders({ deezer: stubProvider("deezer", { searchHits: [superLoud] }) }),
      },
    );
    expect(onlyLoud.recording.title).toMatch(/Midnight Sun/i);
    expect(onlyLoud.links.find((link) => link.platform === "deezer")?.unmatched).toBe(false);

    const both = await resolveTrack(
      { artist: "Zara Larsson", title: "Midnight Sun", album: "Midnight Sun", duration_ms },
      {
        db: memoryStore(),
        providers: mockProviders({ deezer: stubProvider("deezer", { searchHits: [superLoud, bare] }) }),
      },
    );
    expect(both.recording.title).toBe("Midnight Sun");
    expect(both.links.find((link) => link.platform === "deezer")?.url).toBe(bare.url);
  });
});

describe("positive identity controls", () => {
  it("Sneaker Pimps / Becoming Remixed / 543000 picks Armand's Dark Garage Mix over a short original", async () => {
    const original = hit("deezer", {
      id: "spin-orig",
      title: "Spin Spin Sugar",
      artists: ["Sneaker Pimps"],
      album: "Becoming X",
      duration_ms: 260_000,
      isrc: null,
      url: "https://www.deezer.com/track/spin-orig",
    });
    const mix = hit("deezer", {
      id: "spin-armand",
      title: "Spin Spin Sugar (Armand's Dark Garage Mix)",
      artists: ["Sneaker Pimps"],
      album: "Becoming Remixed",
      duration_ms: 543_000,
      isrc: null,
      url: "https://www.deezer.com/track/spin-armand",
    });
    const result = await resolveTrack(
      { artist: "Sneaker Pimps", title: "Spin Spin Sugar", album: "Becoming Remixed", duration_ms: 543_000 },
      {
        db: memoryStore(),
        providers: mockProviders({ deezer: stubProvider("deezer", { searchHits: [original, mix] }) }),
      },
    );
    expect(result.recording.title).toBe("Spin Spin Sugar (Armand's Dark Garage Mix)");
    expect(result.links.find((link) => link.platform === "deezer")?.url).toBe(mix.url);
  });

  it("AL-90 Cyrillic accepts itself", async () => {
    const title = "Завуалированный Сигнал";
    expect(titleSimilarity(title, title)).toBe(1);
    const row = hit("deezer", {
      id: "al90",
      title,
      artists: ["AL-90"],
      album: "Код-915913",
      duration_ms: 306_000,
      isrc: null,
      url: "https://www.deezer.com/track/al90",
    });
    const result = await resolveTrack(
      { artist: "AL-90", title, album: "Код-915913", duration_ms: 306_000 },
      {
        db: memoryStore(),
        providers: mockProviders({ deezer: stubProvider("deezer", { searchHits: [row] }) }),
      },
    );
    expect(result.recording.title).toBe(title);
  });

  it("featured-artist overlap accepts Ariana Grande vs feat. Iggy Azalea", async () => {
    const row = hit("deezer", {
      id: "problem",
      title: "Problem",
      artists: ["Ariana Grande", "Iggy Azalea"],
      duration_ms: 200_000,
      isrc: null,
      url: "https://www.deezer.com/track/problem",
    });
    const result = await resolveTrack(
      { artist: "Ariana Grande feat. Iggy Azalea", title: "Problem", duration_ms: 200_000 },
      {
        db: memoryStore(),
        providers: mockProviders({ deezer: stubProvider("deezer", { searchHits: [row] }) }),
      },
    );
    expect(result.recording.title).toBe("Problem");
    expect(evaluateFuzzy({ title: "Problem", artists: "Ariana Grande", duration_ms: 200_000 }, row).accepted).toBe(
      true,
    );
  });

  it("transliteration hatch (気分上々 vs Kibun Jou Jou + same artist + duration) does not 404", async () => {
    const row = hit("deezer", {
      id: "kibun",
      title: "Kibun Jou Jou",
      artists: ["mihimaru GT"],
      duration_ms: 255_000,
      isrc: null,
      url: "https://www.deezer.com/track/kibun",
    });
    const result = await resolveTrack(
      { artist: "mihimaru GT", title: "気分上々↑↑", duration_ms: 255_000 },
      {
        db: memoryStore(),
        providers: mockProviders({ deezer: stubProvider("deezer", { searchHits: [row] }) }),
      },
    );
    expect(result.recording.title).toBe("Kibun Jou Jou");
  });
});

describe("resolve evidence", () => {
  it("artist+title resolve includes query_match vs destinations; reuse flags and credentials_skipped", async () => {
    const deezerHit = hit("deezer");
    const appleHit = hit("apple");
    const providers = mockProviders({
      deezer: stubProvider("deezer", {
        searchHits: [deezerHit],
        byIsrc: { [deezerHit.isrc!]: deezerHit },
      }),
      apple: stubProvider("apple", { byIsrc: { [deezerHit.isrc!]: appleHit } }),
    });

    const clean = await resolveTrack(
      { artist: "The Weeknd", title: "Blinding Lights", duration_ms: 200_040 },
      { db: memoryStore(), providers },
    );
    expect(clean.evidence.matching_rule_version).toBe(MATCHING_RULE_VERSION);
    expect(clean.evidence.recording_reused).toBe(false);
    expect(clean.evidence.reuse_via).toBeNull();
    expect(clean.evidence.query_match).toMatchObject({ method: "fuzzy" });
    expect(typeof clean.evidence.query_match?.confidence).toBe("number");
    expect(clean.evidence.source?.title).toBe("Blinding Lights");
    expect(clean.evidence.destinations.some((dest) => dest.platform === "deezer" && dest.accepted)).toBe(true);
    expect(clean.evidence.destinations.some((dest) => dest.platform === "apple" && dest.accepted)).toBe(true);
    expect(typeof clean.evidence.credentials_skipped).toBe("number");
    expect(Array.isArray(clean.evidence.providers_enabled)).toBe(true);

    const db = memoryStore();
    const firstIsrc = await resolveTrack({ isrc: deezerHit.isrc! }, { db, providers });
    expect(firstIsrc.evidence.recording_reused).toBe(false);
    const cached = await resolveTrack({ isrc: deezerHit.isrc! }, { db, providers });
    expect(cached.evidence.recording_reused).toBe(true);
    expect(cached.evidence.reuse_via).toBe("input_cache");

    const coalesced = await resolveTrack(
      { artist: "The Weeknd", title: "Blinding Lights", duration_ms: 200_040 },
      { db, providers },
    );
    expect(coalesced.recording.id).toBe(firstIsrc.recording.id);
    expect(coalesced.evidence.recording_reused).toBe(true);
    expect(coalesced.evidence.reuse_via).toBe("isrc");
    expect(coalesced.evidence.query_match?.method).toBe("fuzzy");
    const fuzzyScore = evaluateFuzzy(
      { title: "Blinding Lights", duration_ms: 200_040, artists: "The Weeknd" },
      deezerHit,
    ).confidence;
    expect(coalesced.evidence.query_match?.confidence).toBe(fuzzyScore);
    expect(coalesced.recording_confidence).toBe(0.98);
    expect(coalesced.evidence.query_match?.confidence).not.toBe(0.98);

    const cachedQuery = await resolveTrack(
      { artist: "The Weeknd", title: "Blinding Lights", duration_ms: 200_040 },
      { db, providers },
    );
    expect(cachedQuery.cached).toBe(true);
    expect(cachedQuery.evidence.query_match).toMatchObject({
      method: "fuzzy",
      confidence: null,
      reason: "reconstructed_from_cache",
    });
    expect(cachedQuery.recording_confidence).toBe(0.98);
  });
});
