import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { httpJson } from "../src/http.ts";
import { createTidalProvider } from "../src/providers/tidal.ts";

const config = loadConfig({ TIDAL_CLIENT_ID: "test", TIDAL_CLIENT_SECRET: "test", TIDAL_COUNTRY: "GB" });
const query = { title: "夜 / Day? + Light", artists: ["Artist & Guest"] };
const ref = (id: string) => ({ type: "tracks", id });
const artist = { type: "artists", id: "artist", attributes: { name: "Artist & Guest" } };
const track = (id: string) => ({
  ...ref(id),
  attributes: { title: query.title, duration: "PT3M20.04S", isrc: "USUG11904206" },
  relationships: { artists: { data: [{ type: "artists", id: "artist" }] } },
});

function setup(doc: unknown, status = 200) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const request: typeof httpJson = async <T>(url: string, init?: RequestInit) => {
    calls.push({ url: new URL(url), init });
    const auth = url.includes("auth.tidal.com");
    const json = auth ? { access_token: "test-bearer", expires_in: 3600 } : doc;
    return { ok: auth || status === 200, status: auth ? 200 : status, json: json as T, text: JSON.stringify(json) };
  };
  return { provider: createTidalProvider(config, request), calls };
}

describe("TIDAL catalog transport", () => {
  it("uses collection search with encoded filters and preserves array response ranking", async () => {
    const { provider, calls } = setup({
      data: [{ type: "searchResults", id: "search", relationships: { tracks: { data: [ref("2"), ref("1"), ref("2")] } } }],
      included: [track("unrelated"), track("1"), artist, track("2")],
    });
    const hits = await provider.search(query);
    expect(hits.map((hit) => hit.id)).toEqual(["2", "1"]);
    expect(hits[0]).toMatchObject({ title: query.title, artists: query.artists, duration_ms: 200040, isrc: "USUG11904206" });
    const search = calls[1];
    expect(search.url.pathname).toBe("/v2/searchResults");
    expect(search.url.searchParams.get("filter[query]")).toBe(`${query.artists[0]} ${query.title}`);
    expect(search.url.searchParams.get("countryCode")).toBe("GB");
    expect(search.url.searchParams.get("include")).toBe("tracks,tracks.artists");
    expect(search.init?.headers).toMatchObject({ Authorization: "Bearer test-bearer" });
    await provider.search(query);
    expect(calls.filter((call) => call.url.hostname === "auth.tidal.com")).toHaveLength(1);
  });

  it("supports object-shaped responses and limits ranked hits to eight", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(i));
    const { provider } = setup({
      data: { relationships: { tracks: { data: ids.map(ref) } } },
      included: [...ids.map(track).reverse(), artist],
    });
    expect((await provider.search(query)).map((hit) => hit.id)).toEqual(ids.slice(0, 8));
  });

  it.each([
    { data: [] },
    { data: [{ relationships: { tracks: { data: [] } } }], included: [track("unrelated")] },
    { data: [{ relationships: { tracks: { data: [ref("missing")] } } }] },
  ])("returns no tracks for empty or unresolved linkage", async (doc) => {
    expect(await setup(doc).provider.search(query)).toEqual([]);
  });

  it("can read included tracks when linkage is omitted", async () => {
    const { provider } = setup({ data: [{}], included: [track("1"), artist] });
    expect((await provider.search(query)).map((hit) => hit.id)).toEqual(["1"]);
  });

  it("does not turn an HTTP failure into catalog hits", async () => {
    expect(await setup({ data: [{}], included: [track("1")] }, 400).provider.search(query)).toEqual([]);
  });

  it("keeps direct-ID and ISRC lookups working", async () => {
    const { provider, calls } = setup({ data: [track("1")], included: [artist] });
    expect(await provider.getById("1")).toMatchObject({ id: "1", artists: query.artists });
    expect(await provider.getByIsrc("USUG11904206")).toMatchObject({ id: "1", duration_ms: 200040 });
    expect(calls[1].url.pathname).toBe("/v2/tracks/1");
    expect(calls[2].url.pathname).toBe("/v2/tracks");
    expect(calls[2].url.searchParams.get("filter[isrc]")).toBe("USUG11904206");
  });
});
