import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.ts";
import type { JsonResponse } from "../src/http.ts";
import { createAppleProvider, normalizeApplePrivateKey } from "../src/providers/apple.ts";

function ok<T>(json: T, status = 200): JsonResponse<T> {
  return { ok: status >= 200 && status < 300, status, json, text: JSON.stringify(json) };
}

const catalogConfig = {
  appleMusicToken: "test-token",
  appleStorefront: "us",
} as Config;

describe("Apple catalog + PEM", () => {
  it("re-wraps a single-line PEM into 64-char body lines", () => {
    const body = `${"A".repeat(70)}${"B".repeat(20)}`;
    const singleLine = `-----BEGIN PRIVATE KEY-----${body}-----END PRIVATE KEY-----`;
    const normalized = normalizeApplePrivateKey(singleLine);
    expect(normalized).toBe(
      [
        "-----BEGIN PRIVATE KEY-----",
        "A".repeat(64),
        `${"A".repeat(6)}${"B".repeat(20)}`,
        "-----END PRIVATE KEY-----",
      ].join("\n"),
    );
  });

  it("does not accept an iTunes-only Apple ID when catalog says the song is gone", async () => {
    const urls: string[] = [];
    const provider = createAppleProvider(catalogConfig, async <T>(url: string) => {
      urls.push(url);
      if (url.includes("itunes.apple.com")) {
        return ok({
          results: [
            {
              trackId: 1436568496,
              trackName: "Honey",
              artistName: "Robyn",
              collectionName: "Honey",
              trackTimeMillis: 294000,
            },
          ],
        }) as JsonResponse<T>;
      }
      return ok({ data: [] }, 404) as JsonResponse<T>;
    });

    const hit = await provider.getById("1436568496");
    expect(hit).toBeNull();
    expect(urls.some((url) => url.includes("api.music.apple.com"))).toBe(true);
    expect(urls.some((url) => url.includes("itunes.apple.com"))).toBe(false);
  });

  it("surfaces catalog 401 as credentials_missing", async () => {
    const provider = createAppleProvider(catalogConfig, async <T>() => {
      return { ok: false, status: 401, json: null, text: "unauthorized" } as JsonResponse<T>;
    });
    await provider.getByIsrc("USUG11904206");
    expect(provider.skipReason?.()).toBe("credentials_missing");
  });
});
