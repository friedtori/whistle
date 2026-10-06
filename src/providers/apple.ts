import jwt from "jsonwebtoken";
import type { Config } from "../config.ts";
import { hasAppleCatalogAuth } from "../config.ts";
import { canonicalUrl } from "../ids.ts";
import { asArray, asNumber, asString, httpJson } from "../http.ts";
import type { Provider, SearchQuery, TrackHit } from "../types.ts";

export function createAppleProvider(config: Config): Provider {
  const catalog = hasAppleCatalogAuth(config);

  return {
    platform: "apple",
    enabled: true,
    supportsIsrcLookup: true,
    async getById(id) {
      if (catalog) {
        const token = appleToken(config);
        const store = config.appleStorefront;
        const res = await httpJson<{ data?: AppleSong[] }>(
          `https://api.music.apple.com/v1/catalog/${store}/songs/${encodeURIComponent(id)}`,
          { headers: appleHeaders(token) },
        );
        const song = res.json?.data?.[0];
        if (song) return fromCatalog(song);
      }
      return itunesLookupById(id);
    },
    async getByIsrc(isrc) {
      if (catalog) {
        const token = appleToken(config);
        const store = config.appleStorefront;
        const res = await httpJson<{ data?: AppleSong[] }>(
          `https://api.music.apple.com/v1/catalog/${store}/songs?filter[isrc]=${encodeURIComponent(isrc)}`,
          { headers: appleHeaders(token) },
        );
        const song = res.json?.data?.[0];
        if (song) return fromCatalog(song);
        return null;
      }
      return itunesLookupByIsrc(isrc);
    },
    async search(query: SearchQuery) {
      const term = `${query.artists[0] ?? ""} ${query.title}`.trim();
      if (catalog) {
        const token = appleToken(config);
        const store = config.appleStorefront;
        const res = await httpJson<{ results?: { songs?: { data?: AppleSong[] } } }>(
          `https://api.music.apple.com/v1/catalog/${store}/search?term=${encodeURIComponent(term)}&types=songs&limit=8`,
          { headers: appleHeaders(token) },
        );
        return asArray(res.json?.results?.songs?.data)
          .map((item) => fromCatalog(item as AppleSong))
          .filter((x): x is TrackHit => x !== null);
      }
      return itunesSearch(term);
    },
  };
}

interface AppleSong {
  id?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    durationInMillis?: number;
    isrc?: string;
    url?: string;
  };
}

interface ItunesTrack {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  trackTimeMillis?: number;
  trackViewUrl?: string;
}

function fromCatalog(song: AppleSong): TrackHit | null {
  const id = asString(song.id);
  const title = asString(song.attributes?.name);
  if (!id || !title) return null;
  return {
    platform: "apple",
    id,
    url: asString(song.attributes?.url) ?? canonicalUrl("apple", id),
    title,
    artists: asString(song.attributes?.artistName)
      ? [song.attributes!.artistName!]
      : [],
    duration_ms: asNumber(song.attributes?.durationInMillis),
    isrc: asString(song.attributes?.isrc),
  };
}

function fromItunes(track: ItunesTrack): TrackHit | null {
  if (track.trackId == null || !track.trackName) return null;
  const id = String(track.trackId);
  return {
    platform: "apple",
    id,
    url: asString(track.trackViewUrl)?.replace("itunes.apple.com", "music.apple.com") ??
      canonicalUrl("apple", id),
    title: track.trackName,
    artists: asString(track.artistName) ? [track.artistName!] : [],
    duration_ms: asNumber(track.trackTimeMillis),
  };
}

async function itunesLookupById(id: string): Promise<TrackHit | null> {
  const res = await httpJson<{ results?: ItunesTrack[] }>(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}`,
  );
  return fromItunes(res.json?.results?.[0] ?? {});
}

async function itunesLookupByIsrc(isrc: string): Promise<TrackHit | null> {
  const lookup = await httpJson<{ results?: ItunesTrack[] }>(
    `https://itunes.apple.com/lookup?isrc=${encodeURIComponent(isrc)}&entity=song`,
  );
  const hit = fromItunes(lookup.json?.results?.find((r) => r.trackId) ?? {});
  if (hit) return hit;
  const search = await httpJson<{ results?: ItunesTrack[] }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(isrc)}&entity=song&limit=5`,
  );
  return fromItunes(search.json?.results?.[0] ?? {});
}

async function itunesSearch(term: string): Promise<TrackHit[]> {
  const res = await httpJson<{ results?: ItunesTrack[] }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=8`,
  );
  return asArray(res.json?.results)
    .map((item) => fromItunes(item as ItunesTrack))
    .filter((x): x is TrackHit => x !== null);
}

function appleToken(config: Config): string {
  if (config.appleMusicToken) return config.appleMusicToken;
  const key = (config.applePrivateKey ?? "").replace(/\\n/g, "\n");
  return jwt.sign({}, key, {
    algorithm: "ES256",
    expiresIn: "12h",
    issuer: config.appleTeamId,
    header: { alg: "ES256", kid: config.appleKeyId },
  });
}

function appleHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
