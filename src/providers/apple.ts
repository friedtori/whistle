import jwt from "jsonwebtoken";
import type { Config } from "../config.ts";
import { hasAppleCatalogAuth } from "../config.ts";
import { canonicalUrl } from "../ids.ts";
import { asArray, asNumber, asString, httpJson } from "../http.ts";
import type { Provider, SearchQuery, TrackHit } from "../types.ts";

type HttpJson = typeof httpJson;

export function createAppleProvider(config: Config, http: HttpJson = httpJson): Provider {
  const catalog = hasAppleCatalogAuth(config);

  async function catalogSongById(id: string, token: string): Promise<TrackHit | null> {
    const store = config.appleStorefront;
    const res = await http<{ data?: AppleSong[] }>(
      `https://api.music.apple.com/v1/catalog/${store}/songs/${encodeURIComponent(id)}`,
      { headers: appleHeaders(token) },
    );
    const song = res.json?.data?.[0];
    return song ? fromCatalog(song) : null;
  }

  return {
    platform: "apple",
    enabled: true,
    supportsIsrcLookup: true,
    async getById(id) {
      if (catalog) {
        return catalogSongById(id, appleToken(config));
      }
      return itunesLookupById(http, id);
    },
    async getByIsrc(isrc) {
      if (catalog) {
        const token = appleToken(config);
        const store = config.appleStorefront;
        const res = await http<{ data?: AppleSong[] }>(
          `https://api.music.apple.com/v1/catalog/${store}/songs?filter[isrc]=${encodeURIComponent(isrc)}`,
          { headers: appleHeaders(token) },
        );
        const song = res.json?.data?.[0];
        return song ? fromCatalog(song) : null;
      }
      return itunesLookupByIsrc(http, isrc);
    },
    async search(query: SearchQuery) {
      const term = `${query.artists[0] ?? ""} ${query.title}`.trim();
      if (catalog) {
        const token = appleToken(config);
        const store = config.appleStorefront;
        const res = await http<{ results?: { songs?: { data?: AppleSong[] } } }>(
          `https://api.music.apple.com/v1/catalog/${store}/search?term=${encodeURIComponent(term)}&types=songs&limit=8`,
          { headers: appleHeaders(token) },
        );
        return asArray(res.json?.results?.songs?.data)
          .map((item) => fromCatalog(item as AppleSong))
          .filter((x): x is TrackHit => x !== null);
      }
      return itunesSearch(http, term);
    },
  };
}

interface AppleSong {
  id?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    isrc?: string;
    url?: string;
  };
}

interface ItunesTrack {
  trackId?: number;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
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
    album: asString(song.attributes?.albumName),
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
    album: asString(track.collectionName),
  };
}

async function itunesLookupById(http: HttpJson, id: string): Promise<TrackHit | null> {
  const res = await http<{ results?: ItunesTrack[] }>(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}`,
  );
  return fromItunes(res.json?.results?.[0] ?? {});
}

async function itunesLookupByIsrc(http: HttpJson, isrc: string): Promise<TrackHit | null> {
  const lookup = await http<{ results?: ItunesTrack[] }>(
    `https://itunes.apple.com/lookup?isrc=${encodeURIComponent(isrc)}&entity=song`,
  );
  const hit = fromItunes(lookup.json?.results?.find((r) => r.trackId) ?? {});
  if (hit) return hit;
  const search = await http<{ results?: ItunesTrack[] }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(isrc)}&entity=song&limit=5`,
  );
  return fromItunes(search.json?.results?.[0] ?? {});
}

async function itunesSearch(http: HttpJson, term: string): Promise<TrackHit[]> {
  const res = await http<{ results?: ItunesTrack[] }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=8`,
  );
  return asArray(res.json?.results)
    .map((item) => fromItunes(item as ItunesTrack))
    .filter((x): x is TrackHit => x !== null);
}

export function normalizeApplePrivateKey(raw: string): string {
  const key = raw.replace(/\\n/g, "\n").trim();
  const match = /-----BEGIN ([A-Z ]+)-----([A-Za-z0-9+/=\s]+)-----END \1-----/.exec(key);
  if (!match) return key;
  const label = match[1];
  const body = match[2].replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [body];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

export function appleToken(config: Config): string {
  if (config.appleMusicToken) return config.appleMusicToken;
  const key = normalizeApplePrivateKey(config.applePrivateKey ?? "");
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
