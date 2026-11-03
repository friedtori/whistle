import { describe, expect, it } from "vitest";
import {
  artistOverlaps,
  artistSimilarity,
  destinationMatchesRecording,
  destinationVersionText,
  evaluateFuzzy,
  pickFuzzyMatch,
  titleSimilarity,
  versionKeywordsConflict,
} from "../src/fuzzy.ts";
import { hit } from "./helpers.ts";

describe("fuzzy acceptance gates", () => {
  const studio = { artists: ["The Weeknd"], title: "Blinding Lights", duration_ms: 200_040 };

  it.each(["Purple Rain", "Lights", "Blinding Lights Again"])(
    "rejects an unrelated or partial title: %s", (title) => {
      expect(evaluateFuzzy(studio, { ...studio, title })).toMatchObject({
        accepted: false, reason: "title",
      });
    },
  );

  it.each([["Someone Else"], [], ["Someone Else", "The Weeknd"]])(
    "rejects wrong or missing primary artist credits: %j", (...artists) => {
      expect(evaluateFuzzy(studio, { ...studio, artists })).toMatchObject({
        accepted: false, reason: "artist",
      });
    },
  );

  it("rejects artists sharing just a common token", () => {
    expect(evaluateFuzzy(
      { ...studio, artists: ["John Lennon"] },
      { ...studio, artists: ["John Legend"] },
    )).toMatchObject({ accepted: false, reason: "artist" });
  });

  it.each([
    ["Song (Alpha Remix)", "Song (Beta Remix)"],
    ["Song (Live at Wembley)", "Song (Live at Budokan)"],
    ["Song (Radio Edit)", "Song (Extended Edit)"],
    ["Song", "Song (Demo)"],
  ])("rejects recording variants: %s / %s", (title, other) => {
    expect(evaluateFuzzy({ ...studio, title }, { ...studio, title: other }))
      .toMatchObject({ accepted: false, reason: "version_keyword" });
  });

  it.each([
    ["Song (Alpha Remix)", "Song - Alpha Rmx"],
    ["Song (Alpha Remix)", "Song - Alpha Re-mix"],
    ["Song (2011 Remastered)", "Song - 2011 Remaster"],
    ["Song (feat. Guest)", "Song"],
    ["(Song)", "Song"],
  ])("accepts formatting and spelling variants: %s / %s", (title, other) => {
    expect(evaluateFuzzy({ ...studio, title }, { ...studio, title: other }).accepted).toBe(true);
  });

  it.each([
    ["夜に駆ける", "YOASOBI"],
    ["First Love", "宇多田ヒカル"],
    ["Камин", "Эмин"],
    ["তুমি", "শিল্পী"],
    ["Déjà vu", "Beyoncé"],
    ["This Is the Day", "The The"],
  ])("preserves Unicode title and artist: %s / %s", (title, artist) => {
    const track = { ...studio, title, artists: [artist] };
    expect(evaluateFuzzy(track, {
      ...track, title: title.normalize("NFD"), artists: [artist.normalize("NFD")],
    }).accepted).toBe(true);
  });

  it("does not equate different non-Latin titles", () => {
    expect(evaluateFuzzy(
      { ...studio, title: "夜に駆ける" }, { ...studio, title: "群青" },
    )).toMatchObject({ accepted: false, reason: "title" });
  });

  it("does not let matching album metadata rescue a wrong performer", () => {
    expect(pickFuzzyMatch({ ...studio, album: "After Hours" }, [
      hit("apple", { artists: ["Tribute Band"], album: "After Hours" }),
    ])).toBeNull();
  });

  it("accepts a candidate within 2s with the same version keywords", () => {
    const decision = evaluateFuzzy(studio, {
      title: "Blinding Lights",
      artists: ["The Weeknd"],
      duration_ms: 201_500,
    });
    expect(decision.accepted).toBe(true);
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThanOrEqual(0.8);
  });

  it("rejects duration drift over 2s", () => {
    expect(
      evaluateFuzzy(studio, { artists: ["The Weeknd"], title: "Blinding Lights", duration_ms: 205_000 }).accepted,
    ).toBe(false);
  });

  it("rejects when a version keyword differs (live / remix / edit / remaster)", () => {
    expect(versionKeywordsConflict("Blinding Lights", "Blinding Lights (Live)")).toBe(true);
    expect(
      evaluateFuzzy(studio, { artists: ["The Weeknd"], title: "Blinding Lights (Live)", duration_ms: 200_040 }).accepted,
    ).toBe(false);
    expect(
      evaluateFuzzy(studio, { artists: ["The Weeknd"], title: "Blinding Lights (Remix)", duration_ms: 200_040 }).accepted,
    ).toBe(false);
    expect(
      evaluateFuzzy(
        { artists: ["The Weeknd"], title: "Song (Remastered)", duration_ms: 180_000 },
        { artists: ["The Weeknd"], title: "Song", duration_ms: 180_000 },
      ).accepted,
    ).toBe(false);
  });

  it("allows matching version keywords on both sides", () => {
    expect(
      evaluateFuzzy(
        { artists: ["The Weeknd"], title: "Song (Live)", duration_ms: 180_000 },
        { artists: ["The Weeknd"], title: "Song - Live", duration_ms: 180_400 },
      ).accepted,
    ).toBe(true);
  });

  it("rejects fuzzy when duration is missing", () => {
    expect(evaluateFuzzy({ artists: ["The Weeknd"], title: "Song", duration_ms: null }, { artists: ["The Weeknd"], title: "Song", duration_ms: 1000 }).accepted).toBe(
      false,
    );
  });

  it("rejects remaster vs original even when duration matches", () => {
    expect(
      evaluateFuzzy(
        { artists: ["The Weeknd"], title: "Blinding Lights", duration_ms: 200_040 },
        { artists: ["The Weeknd"], title: "Blinding Lights (Remastered)", duration_ms: 200_040 },
      ).accepted,
    ).toBe(false);
  });

  it("requires artist token overlap for bootstrap candidates", () => {
    expect(artistOverlaps("The Weeknd", ["The Weeknd"])).toBe(true);
    expect(artistOverlaps("The Weeknd", ["Weeknd"])).toBe(true);
    expect(artistOverlaps("The Weeknd", ["Taylor Swift"])).toBe(false);
    expect(artistSimilarity("The Weeknd", ["Taylor Swift"])).toBe(0);
  });

  it("treats collapsed titles as equal (HandsOn vs Hands On)", () => {
    expect(titleSimilarity("HandsOn", "Hands On")).toBe(1);
    expect(
      evaluateFuzzy({ artists: ["A"], title: "HandsOn", duration_ms: 200_000 }, { artists: ["A"], title: "Hands On", duration_ms: 200_000 })
        .accepted,
    ).toBe(true);
  });

  it("rejects unrelated titles even when duration matches (title similarity floor)", () => {
    expect(
      evaluateFuzzy(
        { artists: ["A"], title: "Pigwig", duration_ms: 210_000 },
        { artists: ["A"], title: "Now We Can't Be Friends", duration_ms: 210_000 },
      ).accepted,
    ).toBe(false);
    expect(
      evaluateFuzzy({ artists: ["A"], title: "Dexter", duration_ms: 400_000 }, { artists: ["A"], title: "Nord", duration_ms: 400_000 }).accepted,
    ).toBe(false);
    expect(
      evaluateFuzzy(
        { artists: ["A"], title: "HandsOn", duration_ms: 200_000 },
        { artists: ["A"], title: "Wild Storm", duration_ms: 200_000 },
      ).accepted,
    ).toBe(false);
  });

  // Reconciled with main@c26f802: fuzzy acceptance does not implement cross-script
  // transliteration, so the PR #5 hatch is not an acceptance path. It remains only in
  // the destination contradiction check for identifier-backed (ISRC/MB) hops.
  it("rejects a Latin/non-Latin transliteration pair in fuzzy acceptance", () => {
    expect(titleSimilarity("気分上々↑↑", "Kibun Jou Jou")).toBe(0);
    expect(
      evaluateFuzzy(
        { title: "気分上々↑↑", artists: "mihimaru GT", duration_ms: 255_000 },
        { title: "Kibun Jou Jou", artists: ["mihimaru GT"], duration_ms: 255_000 },
      ),
    ).toMatchObject({ accepted: false, reason: "title" });
  });

  it("rejects remix vs acapella as a version-keyword conflict (not a safe automatic match)", () => {
    expect(versionKeywordsConflict("thicc (Fedde Le Grand remix)", "thicc (acapella)")).toBe(true);
    expect(versionKeywordsConflict("thicc (remix)", "thicc (a cappella)")).toBe(true);
    expect(versionKeywordsConflict("thicc (remix)", "thicc (acappella)")).toBe(true);
    expect(versionKeywordsConflict("thicc (remix)", "thicc (a capella)")).toBe(true);
    expect(
      evaluateFuzzy(
        { artists: ["A"], title: "thicc (Fedde Le Grand remix)", duration_ms: 200_000 },
        { artists: ["A"], title: "thicc (acapella)", duration_ms: 200_000 },
      ).accepted,
    ).toBe(false);
  });

  it("keeps Unicode letters so Cyrillic titles score 1 against themselves", () => {
    expect(titleSimilarity("Завуалированный Сигнал", "Завуалированный Сигнал")).toBe(1);
    expect(
      evaluateFuzzy(
        { artists: ["A"], title: "Завуалированный Сигнал", duration_ms: 306_000 },
        { artists: ["A"], title: "Завуалированный Сигнал", duration_ms: 306_000 },
      ).accepted,
    ).toBe(true);
  });

  it("does not treat a Latin/non-Latin pair as a contradiction on identifier-backed hops", () => {
    const recording = { title: "気分上々↑↑", artists: ["mihimaru GT"], duration_ms: 200_000 };
    expect(
      destinationMatchesRecording(recording, {
        title: "Kibun Jou Jou",
        artists: ["mihimaru GT"],
        duration_ms: 200_000,
      }),
    ).toBe(true);
    expect(
      destinationMatchesRecording(recording, {
        title: "Kibun Jou Jou",
        artists: ["Harusaruhi"],
        duration_ms: 200_000,
      }),
    ).toBe(false);
  });

  it("treats featured-artist supersets and punctuation credits as artist overlap", () => {
    expect(artistOverlaps("Ariana Grande feat. Iggy Azalea", ["Ariana Grande"])).toBe(true);
    expect(artistOverlaps("Ariana Grande", ["Ariana Grande", "Iggy Azalea"])).toBe(true);
    expect(artistOverlaps("Olivia O'Brien", ["Olivia OBrien"])).toBe(true);
  });

  it("scans destination album and URL slug for version keywords", () => {
    const dest = {
      title: "Kibun Jou Jou",
      artists: ["Harusaruhi"],
      duration_ms: 200_000,
      album: "Kibun Jou Jou (Cover)",
      url: "https://music.apple.com/us/album/kibun-jou-jou-cover/1709945211?i=1709945229",
    };
    expect(destinationVersionText(dest).toLowerCase()).toContain("cover");
    expect(versionKeywordsConflict("Kibun Jou Jou", destinationVersionText(dest))).toBe(true);
    expect(
      destinationMatchesRecording(
        { title: "Kibun Jou Jou", artists: ["mihimaru GT"], duration_ms: 200_000 },
        dest,
      ),
    ).toBe(false);
  });

  it("prefers the candidate whose album matches the query over a compilation", () => {
    const source = { artists: ["Alanis Morissette"], title: "Ironic", duration_ms: 230_000, album: "Jagged Little Pill" };
    const studio = hit("deezer", {
      id: "1",
      title: "Ironic",
      artists: ["Alanis Morissette"],
      album: "Jagged Little Pill",
      duration_ms: 230_000,
    });
    const compilation = hit("deezer", {
      id: "2",
      title: "Ironic",
      artists: ["Alanis Morissette"],
      album: "The Collection",
      duration_ms: 230_000,
    });
    const picked = pickFuzzyMatch(source, [compilation, studio]);
    expect(picked?.hit.id).toBe("1");
    expect(picked?.hit.album).toBe("Jagged Little Pill");
  });
});

describe("reconciled gates (PR #5 on main@c26f802)", () => {
  const recording = { title: "Song", artists: ["Artist"], duration_ms: 200_000 };

  it("destination contradiction check ignores parenthetical subtitles on identifier-backed hops", () => {
    expect(
      destinationMatchesRecording(recording, {
        title: "Song (From the Motion Picture)",
        artists: ["Artist"],
        duration_ms: 200_000,
      }),
    ).toBe(true);
  });

  it("destination contradiction check still rejects a version-family mismatch", () => {
    expect(
      destinationMatchesRecording(recording, { title: "Song (Live)", artists: ["Artist"], duration_ms: 200_000 }),
    ).toBe(false);
  });

  it("fuzzy acceptance keeps main's 0.8 title threshold (no substring bonus)", () => {
    expect(
      evaluateFuzzy(
        { ...recording, title: "Midnight Sun" },
        { ...recording, title: "Midnight Sun (Super Loud)" },
      ),
    ).toMatchObject({ accepted: false, reason: "title" });
  });

  it("version families from album and URL slug still count in fuzzy acceptance", () => {
    expect(
      evaluateFuzzy(recording, {
        ...recording,
        url: "https://music.apple.com/us/album/song-instrumental/1?i=2",
      }),
    ).toMatchObject({ accepted: false, reason: "version_keyword" });
  });

  it("collapsed titles still match under version normalization", () => {
    expect(
      evaluateFuzzy({ ...recording, title: "HandsOn" }, { ...recording, title: "Hands On" }).accepted,
    ).toBe(true);
  });
});
