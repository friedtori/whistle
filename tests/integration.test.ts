import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { createProviders } from "../src/providers/index.ts";
import request from "supertest";

const live = process.env.WHISTLE_LIVE_TESTS === "1";

describe.skipIf(!live)("live providers (WHISTLE_LIVE_TESTS=1)", () => {
  const config = loadConfig();
  const db = new Store(":memory:");
  const providers = createProviders(config);
  const app = createApp({ db, providers });

  afterAll(() => db.close());

  it("resolves a well-known ISRC via public Deezer + MusicBrainz", async () => {
    const res = await request(app).get("/v1/resolve").query({ isrc: "USUG11904206" });
    expect(res.status).toBe(200);
    expect(res.body.recording.title.toLowerCase()).toContain("blinding");
    const deezer = res.body.links.find((link: { platform: string }) => link.platform === "deezer");
    const mb = res.body.links.find((link: { platform: string }) => link.platform === "musicbrainz");
    expect(deezer.unmatched === false || mb.unmatched === false).toBe(true);
    for (const link of res.body.links) {
      expect(link).toHaveProperty("confidence");
      expect(link).toHaveProperty("method");
    }

    const cached = await request(app).get("/v1/resolve").query({ isrc: "USUG11904206" });
    expect(cached.body.cached).toBe(true);
  });

  it("resolves a Deezer URL and fills at least one other platform", async () => {
    const res = await request(app)
      .get("/v1/resolve")
      .query({ url: "https://www.deezer.com/track/908604612" });
    expect(res.status).toBe(200);
    const matched = res.body.links.filter((link: { unmatched: boolean }) => !link.unmatched);
    expect(matched.length).toBeGreaterThanOrEqual(1);
    expect(matched.some((link: { platform: string }) => link.platform !== "deezer")).toBe(true);
  });
});
