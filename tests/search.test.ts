import { describe, expect, it } from "vitest";
import type { TrackHit } from "../src/types.ts";
import { escapeLucene, plainSearchQuery, searchWithPlainFallback } from "../src/providers/search.ts";
import { hit } from "./helpers.ts";

describe("search query fallback + escaping", () => {
  it("escapes Lucene operators in plain MusicBrainz queries", () => {
    const plain = plainSearchQuery(
      { title: "Prokofiev: Flute Sonata", artists: ["Jean-Pierre Rampal"] },
      escapeLucene,
    );
    expect(plain).toContain("Prokofiev\\:");
    expect(plain).not.toMatch(/(?<!\\):/);
  });

  it("retries the plain query when strict hits exist but none are accepted", async () => {
    const calls: string[] = [];
    const live = hit("deezer", { id: "1", title: "Blinding Lights (Live)", duration_ms: 200_040 });
    const studio = hit("deezer", { id: "2", title: "Blinding Lights", duration_ms: 200_040 });
    const hits = await searchWithPlainFallback(
      {
        title: "Blinding Lights",
        artists: ["The Weeknd"],
        acceptHits: (candidates) => candidates.some((item) => !/live/i.test(item.title)),
      },
      'artist:"The Weeknd" track:"Blinding Lights"',
      async (q) => {
        calls.push(q);
        return q.includes("artist:") ? [live] : [studio];
      },
    );

    expect(calls).toEqual([
      'artist:"The Weeknd" track:"Blinding Lights"',
      "The Weeknd Blinding Lights",
    ]);
    expect(hits.map((item: TrackHit) => item.id)).toEqual(["2"]);
  });
});
