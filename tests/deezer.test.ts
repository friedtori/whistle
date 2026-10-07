import { describe, expect, it } from "vitest";
import type { JsonResponse } from "../src/http.ts";
import { createDeezerProvider } from "../src/providers/deezer.ts";

function ok<T>(json: T): JsonResponse<T> {
  return { ok: true, status: 200, json, text: JSON.stringify(json) };
}

describe("Deezer search fallback", () => {
  it("retries a plain artist title query when the strict advanced search is empty", async () => {
    const calls: string[] = [];
    const provider = createDeezerProvider(async <T>(url: string) => {
      calls.push(url);
      const decoded = decodeURIComponent(url);
      if (decoded.includes('artist:"Alanis Morissette"')) {
        return ok({ data: [] }) as JsonResponse<T>;
      }
      return ok({
        data: [
          {
            id: 21100002,
            title: "Narcissus",
            duration: 218,
            artist: { name: "Alanis Morissette" },
            album: { title: "Under Rug Swept" },
            isrc: "USMV21100002",
          },
        ],
      }) as JsonResponse<T>;
    });

    const hits = await provider.search({
      title: "Narcissus",
      artists: ["Alanis Morissette"],
      duration_ms: 218_000,
    });

    expect(calls).toHaveLength(2);
    expect(decodeURIComponent(calls[0])).toContain('artist:"Alanis Morissette" track:"Narcissus"');
    expect(decodeURIComponent(calls[1])).toContain('q="Alanis Morissette Narcissus"');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      title: "Narcissus",
      duration_ms: 218_000,
      album: "Under Rug Swept",
    });
  });

  it("retries plain search when strict hits fail the acceptance gate", async () => {
    const calls: string[] = [];
    const provider = createDeezerProvider(async <T>(url: string) => {
      const decoded = decodeURIComponent(url);
      calls.push(decoded);
      if (decoded.includes("artist:")) {
        return ok({
          data: [{ id: 1, title: "Narcissus (Live)", duration: 240, artist: { name: "Alanis Morissette" } }],
        }) as JsonResponse<T>;
      }
      return ok({
        data: [{ id: 2, title: "Narcissus", duration: 218, artist: { name: "Alanis Morissette" } }],
      }) as JsonResponse<T>;
    });

    const hits = await provider.search({
      title: "Narcissus",
      artists: ["Alanis Morissette"],
      acceptHits: (candidates) => candidates.some((item) => item.title === "Narcissus"),
    });

    expect(calls).toHaveLength(2);
    expect(hits[0]?.id).toBe("2");
  });
});
