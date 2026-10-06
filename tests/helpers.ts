import { Store } from "../src/db.ts";
import type { MusicBrainzProvider, Platform, Provider, ProviderMap, SearchQuery, TrackHit } from "../src/types.ts";

export const BLINDING_LIGHTS = {
  title: "Blinding Lights",
  artists: ["The Weeknd"],
  duration_ms: 200_040,
  isrc: "USUG11904206",
  ids: {
    deezer: "916424",
    apple: "1493988146",
    spotify: "0VjIjW4GlUZAMYd2vXMi3b",
    tidal: "126173746",
    musicbrainz: "0af65fc4-5ef7-4c0e-8f6b-0c1e6c0d8e11",
    ytm: "4NRXx6U63PY",
  },
  urls: {
    deezer: "https://www.deezer.com/track/916424",
    apple: "https://music.apple.com/us/song/1493988146",
    spotify: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
    tidal: "https://tidal.com/browse/track/126173746",
    musicbrainz: "https://musicbrainz.org/recording/0af65fc4-5ef7-4c0e-8f6b-0c1e6c0d8e11",
    ytm: "https://music.youtube.com/watch?v=4NRXx6U63PY",
  },
};

export function hit(platform: Platform, overrides: Partial<TrackHit> = {}): TrackHit {
  const id = overrides.id ?? BLINDING_LIGHTS.ids[platform];
  return {
    platform,
    id,
    url: overrides.url ?? BLINDING_LIGHTS.urls[platform],
    title: overrides.title ?? BLINDING_LIGHTS.title,
    artists: overrides.artists ?? BLINDING_LIGHTS.artists,
    duration_ms: overrides.duration_ms ?? BLINDING_LIGHTS.duration_ms,
    isrc: overrides.isrc === undefined ? BLINDING_LIGHTS.isrc : overrides.isrc,
    mbid: overrides.mbid ?? (platform === "musicbrainz" ? BLINDING_LIGHTS.ids.musicbrainz : null),
  };
}

export function stubProvider(platform: Platform, opts: {
  enabled?: boolean;
  supportsIsrcLookup?: boolean;
  byId?: Record<string, TrackHit | null>;
  byIsrc?: Record<string, TrackHit | null>;
  searchHits?: TrackHit[];
} = {}): Provider {
  return {
    platform,
    enabled: opts.enabled ?? true,
    supportsIsrcLookup: opts.supportsIsrcLookup ?? platform !== "ytm",
    async getById(id) {
      return opts.byId?.[id] ?? null;
    },
    async getByIsrc(isrc) {
      return opts.byIsrc?.[isrc] ?? null;
    },
    async search(_query: SearchQuery) {
      return opts.searchHits ?? [];
    },
  };
}

export function stubMb(opts: {
  byId?: Record<string, TrackHit | null>;
  byIsrc?: Record<string, TrackHit | null>;
  byUrl?: Record<string, TrackHit | null>;
  relations?: Array<{ platform: Platform; id: string; url: string }>;
  searchHits?: TrackHit[];
} = {}): MusicBrainzProvider {
  return {
    ...stubProvider("musicbrainz", opts),
    async getByUrl(url) {
      return opts.byUrl?.[url] ?? null;
    },
    async getUrlRelations() {
      return opts.relations ?? [];
    },
  };
}

export function mockProviders(overrides: Partial<ProviderMap> = {}): ProviderMap {
  return {
    apple: stubProvider("apple"),
    deezer: stubProvider("deezer"),
    tidal: stubProvider("tidal", { enabled: false }),
    musicbrainz: stubMb(),
    spotify: stubProvider("spotify", { enabled: false }),
    ytm: stubProvider("ytm", { enabled: false, supportsIsrcLookup: false }),
    ...overrides,
  };
}

export function memoryStore(): Store {
  return new Store(":memory:");
}
