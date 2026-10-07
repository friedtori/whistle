import { canonicalUrl } from "../ids.ts";
import { asArray, asNumber, asString, httpJson } from "../http.ts";
import { searchWithPlainFallback } from "./search.ts";
import type { Provider, SearchQuery, TrackHit } from "../types.ts";

type HttpJson = typeof httpJson;

interface DeezerTrack {
  id?: number;
  title?: string;
  duration?: number;
  isrc?: string;
  link?: string;
  artist?: { name?: string };
  album?: { title?: string };
  contributors?: Array<{ name?: string }>;
  error?: { code?: number; message?: string };
}

export function createDeezerProvider(http: HttpJson = httpJson): Provider {
  return {
    platform: "deezer",
    enabled: true,
    supportsIsrcLookup: true,
    async getById(id) {
      const res = await http<DeezerTrack>(`https://api.deezer.com/track/${encodeURIComponent(id)}`);
      return res.ok ? toHit(res.json) : null;
    },
    async getByIsrc(isrc) {
      const res = await http<DeezerTrack>(
        `https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`,
      );
      return res.ok ? toHit(res.json) : null;
    },
    async search(query: SearchQuery) {
      return searchWithPlainFallback(
        query,
        `artist:"${query.artists[0] ?? ""}" track:"${query.title}"`,
        async (q) => {
          const res = await http<{ data?: DeezerTrack[] }>(
            `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=8`,
          );
          if (!res.ok || !res.json) return [];
          return asArray(res.json.data)
            .map((item) => toHit(item as DeezerTrack))
            .filter((x): x is TrackHit => x !== null);
        },
      );
    },
  };
}

function toHit(raw: DeezerTrack | null): TrackHit | null {
  if (!raw || raw.error || raw.id == null || !raw.title) return null;
  const artists: string[] = [];
  const artist = asString(raw.artist?.name);
  if (artist) artists.push(artist);
  for (const contributor of raw.contributors ?? []) {
    const name = asString(contributor.name);
    if (name && !artists.includes(name)) artists.push(name);
  }
  const id = String(raw.id);
  return {
    platform: "deezer",
    id,
    url: asString(raw.link) ?? canonicalUrl("deezer", id),
    title: raw.title,
    artists,
    duration_ms: asNumber(raw.duration) != null ? raw.duration! * 1000 : null,
    album: asString(raw.album?.title),
    isrc: asString(raw.isrc),
  };
}
