import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/worker.ts";
import { freshStore } from "./helpers.ts";

// Live providers through the real Worker entry (D1 + MusicBrainzGate Durable
// Object). Opt-in only: WHISTLE_LIVE_TESTS=1 npm test. Deezer and MusicBrainz
// need no keys; other platforms are skipped unless their secrets are bound.
const live = env.WHISTLE_LIVE_TESTS === "1";

async function get(path: string) {
  const res = await worker.fetch(
    new Request(`https://whistle.test${path}`) as Request<unknown, IncomingRequestCfProperties>,
    env,
    createExecutionContext(),
  );
  return { status: res.status, body: (await res.json()) as any };
}

describe.skipIf(!live)("live providers (WHISTLE_LIVE_TESTS=1)", () => {
  it("resolves a well-known ISRC via public Deezer + MusicBrainz", async () => {
    await freshStore();
    const res = await get("/v1/resolve?isrc=USUG11904206");
    expect(res.status).toBe(200);
    expect(res.body.recording.title.toLowerCase()).toContain("blinding");
    const deezer = res.body.links.find((link: { platform: string }) => link.platform === "deezer");
    const mb = res.body.links.find((link: { platform: string }) => link.platform === "musicbrainz");
    expect(deezer.unmatched === false || mb.unmatched === false).toBe(true);
    for (const link of res.body.links) {
      expect(link).toHaveProperty("confidence");
      expect(link).toHaveProperty("method");
    }

    const cached = await get("/v1/resolve?isrc=USUG11904206");
    expect(cached.body.cached).toBe(true);
  });

  it("resolves a Deezer URL and fills at least one other platform", async () => {
    await freshStore();
    const res = await get(`/v1/resolve?url=${encodeURIComponent("https://www.deezer.com/track/908604612")}`);
    expect(res.status).toBe(200);
    const matched = res.body.links.filter((link: { unmatched: boolean }) => !link.unmatched);
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(matched.some((link: { platform: string }) => link.platform !== "deezer")).toBe(true);
  });
});
