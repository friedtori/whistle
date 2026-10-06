import { describe, expect, it } from "vitest";
import { evaluateFuzzy, versionKeywordsConflict } from "../src/fuzzy.ts";

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
});
