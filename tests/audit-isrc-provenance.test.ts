import { describe, expect, it } from "vitest";
import { resolveTrack } from "../src/pipeline.ts";
import { BLINDING_LIGHTS, hit, freshStore, mockProviders, stubMb, stubProvider } from "./helpers.ts";

// Milestone A audit: an ISRC whose only provenance is a fuzzy match must never
// surface as `method: "isrc"`, including via MusicBrainz sibling ISRCs.
describe("isrc_from_fuzzy provenance (audit)", () => {
  it("artist+title: an MB hop reached via a fuzzy ISRC does not make siblings trusted", async () => {
    const fuzzyIsrc = BLINDING_LIGHTS.isrc;
    const sibling = "USSIB0000009";
    const mbHit = hit("musicbrainz", { isrc: fuzzyIsrc, isrcs: [fuzzyIsrc, sibling] });
    const providers = mockProviders({
      deezer: stubProvider("deezer", { searchHits: [hit("deezer")] }),
      apple: stubProvider("apple", {}),
      tidal: stubProvider("tidal", { byIsrc: { [sibling]: hit("tidal", { isrc: sibling }) } }),
      musicbrainz: stubMb({ byIsrc: { [fuzzyIsrc]: mbHit } }),
      spotify: stubProvider("spotify", { byIsrc: { [sibling]: hit("spotify", { isrc: sibling }) } }),
    });
    const result = await resolveTrack(
      { artist: "The Weeknd", title: "Blinding Lights", duration_ms: 200_040 },
      { db: await freshStore(), providers },
    );
    const matched = result.links.filter((link) => !link.unmatched);
    expect(matched.map((link) => link.method)).not.toContain("isrc");
    expect(result.identifiers.some((id) => id.kind === "isrc")).toBe(false);
    expect(result.recording_confidence).toBeLessThanOrEqual(0.8);
    for (const platform of ["musicbrainz", "tidal", "spotify"] as const) {
      expect(result.links.find((link) => link.platform === platform)).toMatchObject({
        unmatched: false,
        method: "isrc_from_fuzzy",
        confidence: 0.8 * 0.98,
      });
    }
  });
});
