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
  const studio = { title: "Blinding Lights", duration_ms: 200_040 };

  it("accepts a candidate within 2s with the same version keywords", () => {
    const decision = evaluateFuzzy(studio, {
      title: "Blinding Lights",
      duration_ms: 201_500,
    });
    expect(decision.accepted).toBe(true);
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThanOrEqual(0.8);
  });

  it("rejects duration drift over 2s", () => {
    expect(
      evaluateFuzzy(studio, { title: "Blinding Lights", duration_ms: 205_000 }).accepted,
    ).toBe(false);
  });

  it("rejects when a version keyword differs (live / remix / edit / remaster)", () => {
    expect(versionKeywordsConflict("Blinding Lights", "Blinding Lights (Live)")).toBe(true);
    expect(
      evaluateFuzzy(studio, { title: "Blinding Lights (Live)", duration_ms: 200_040 }).accepted,
    ).toBe(false);
    expect(
      evaluateFuzzy(studio, { title: "Blinding Lights (Remix)", duration_ms: 200_040 }).accepted,
    ).toBe(false);
    expect(
      evaluateFuzzy(
        { title: "Song (Remastered)", duration_ms: 180_000 },
        { title: "Song", duration_ms: 180_000 },
      ).accepted,
    ).toBe(false);
  });

  it("allows matching version keywords on both sides", () => {
    expect(
      evaluateFuzzy(
        { title: "Song (Live)", duration_ms: 180_000 },
        { title: "Song - Live", duration_ms: 180_400 },
      ).accepted,
    ).toBe(true);
  });

  it("rejects fuzzy when duration is missing", () => {
    expect(evaluateFuzzy({ title: "Song", duration_ms: null }, { title: "Song", duration_ms: 1000 }).accepted).toBe(
      false,
    );
  });

  it("rejects remaster vs original even when duration matches", () => {
    expect(
      evaluateFuzzy(
        { title: "Blinding Lights", duration_ms: 200_040 },
        { title: "Blinding Lights (Remastered)", duration_ms: 200_040 },
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
      evaluateFuzzy({ title: "HandsOn", duration_ms: 200_000 }, { title: "Hands On", duration_ms: 200_000 })
        .accepted,
    ).toBe(true);
  });

  it("rejects unrelated titles even when duration matches (title similarity floor)", () => {
    expect(
      evaluateFuzzy(
        { title: "Pigwig", duration_ms: 210_000 },
        { title: "Now We Can't Be Friends", duration_ms: 210_000 },
      ).accepted,
    ).toBe(false);
    expect(
      evaluateFuzzy({ title: "Dexter", duration_ms: 400_000 }, { title: "Nord", duration_ms: 400_000 }).accepted,
    ).toBe(false);
    expect(
      evaluateFuzzy(
        { title: "HandsOn", duration_ms: 200_000 },
        { title: "Wild Storm", duration_ms: 200_000 },
      ).accepted,
    ).toBe(false);
  });

  it("does not mint a perfect title score for a transliteration hatch", () => {
    const decision = evaluateFuzzy(
      { title: "気分上々↑↑", artists: "mihimaru GT", duration_ms: 255_000 },
      { title: "Kibun Jou Jou", artists: ["mihimaru GT"], duration_ms: 255_000 },
    );
    expect(decision.accepted).toBe(true);
    expect(decision.confidence).toBeLessThan(0.8);
    expect(titleSimilarity("気分上々↑↑", "Kibun Jou Jou")).toBe(0);
  });

  it("rejects remix vs acapella as a version-keyword conflict (not a safe automatic match)", () => {
    expect(versionKeywordsConflict("thicc (Fedde Le Grand remix)", "thicc (acapella)")).toBe(true);
    expect(versionKeywordsConflict("thicc (remix)", "thicc (a cappella)")).toBe(true);
    expect(versionKeywordsConflict("thicc (remix)", "thicc (acappella)")).toBe(true);
    expect(versionKeywordsConflict("thicc (remix)", "thicc (a capella)")).toBe(true);
    expect(
      evaluateFuzzy(
        { title: "thicc (Fedde Le Grand remix)", duration_ms: 200_000 },
        { title: "thicc (acapella)", duration_ms: 200_000 },
      ).accepted,
    ).toBe(false);
  });

  it("keeps Unicode letters so Cyrillic titles score 1 against themselves", () => {
    expect(titleSimilarity("Завуалированный Сигнал", "Завуалированный Сигнал")).toBe(1);
    expect(
      evaluateFuzzy(
        { title: "Завуалированный Сигнал", duration_ms: 306_000 },
        { title: "Завуалированный Сигнал", duration_ms: 306_000 },
      ).accepted,
    ).toBe(true);
  });

  it("does not reject a Latin/non-Latin transliteration pair on title similarity alone", () => {
    expect(
      evaluateFuzzy(
        { title: "気分上々↑↑", artists: "mihimaru GT", duration_ms: 200_000 },
        { title: "Kibun Jou Jou", artists: ["mihimaru GT"], duration_ms: 200_000 },
      ).accepted,
    ).toBe(true);
    expect(
      evaluateFuzzy(
        { title: "気分上々↑↑", artists: "mihimaru GT", duration_ms: 200_000 },
        { title: "Kibun Jou Jou", artists: ["Harusaruhi"], duration_ms: 200_000 },
      ).accepted,
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
    const source = { title: "Ironic", duration_ms: 230_000, album: "Jagged Little Pill" };
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
