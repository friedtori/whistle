import { env } from "cloudflare:test";
import { createApp } from "../src/app.ts";
import { AuthStore } from "../src/auth-store.ts";
import {
  DEFAULT_BATCH_MAX_INPUTS,
  DEFAULT_RESOLVE_SUBREQUEST_CAP,
  DEFAULT_SUBREQUEST_LIMIT,
} from "../src/config.ts";
import { D1Store } from "../src/db.ts";
import { SubrequestBudget } from "../src/http.ts";
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
    album: overrides.album,
    isrc: overrides.isrc === undefined ? BLINDING_LIGHTS.isrc : overrides.isrc,
    isrcs: overrides.isrcs,
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
      const isrcs = new Set<string>();
      for (const hit of Object.values(opts.byIsrc ?? {})) {
        if (!hit) continue;
        if (hit.isrc) isrcs.add(hit.isrc);
        for (const sibling of hit.isrcs ?? []) isrcs.add(sibling);
      }
      for (const hit of Object.values(opts.byId ?? {})) {
        if (!hit) continue;
        if (hit.isrc) isrcs.add(hit.isrc);
        for (const sibling of hit.isrcs ?? []) isrcs.add(sibling);
      }
      return { relations: opts.relations ?? [], isrcs: [...isrcs] };
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

/**
 * A store over the local test D1 database with every table emptied. Tests run
 * sequentially within a file, so "fresh" means "nothing from earlier tests".
 */
export async function freshStore(): Promise<D1Store> {
  await env.DB.batch(
    [
      "corrections",
      "platform_links",
      "identifiers",
      "recordings",
      "verification_nonces",
      "quota_counters",
    ].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
  return new D1Store(env.DB);
}

export interface TestServicesOptions {
  subrequestLimit?: number;
  resolveSubrequestCap?: number;
  batchMaxInputs?: number;
  /** Build providers from the per-resolve budget (defaults to the fixed `providers`). */
  providersFor?: (budget: SubrequestBudget) => ProviderMap;
  /** Enable the verification handshake and quotas. */
  verification?: {
    anonResolvesPerHour?: number;
    verifiedResolvesPerDay?: number;
    gumLicensePublicKey?: string;
    sessionSecret?: string;
  };
  now?: () => number;
}

/** Hono app over the test D1 store with stub providers. */
export function testApp(db: D1Store, providers: ProviderMap, options: TestServicesOptions = {}) {
  const config = {
    resolveSubrequestCap: options.resolveSubrequestCap ?? DEFAULT_RESOLVE_SUBREQUEST_CAP,
    batchMaxInputs: options.batchMaxInputs ?? DEFAULT_BATCH_MAX_INPUTS,
  };
  return createApp(() => {
    const budget = new SubrequestBudget(options.subrequestLimit ?? DEFAULT_SUBREQUEST_LIMIT);
    return {
      config,
      budget,
      db: new D1Store(db.db, budget),
      providers: options.providersFor ?? (() => providers),
      now: options.now,
      verification: options.verification
        ? {
            store: new AuthStore(db.db, budget),
            config: {
              anonResolvesPerHour: options.verification.anonResolvesPerHour ?? 60,
              verifiedResolvesPerDay: options.verification.verifiedResolvesPerDay ?? 2000,
              gumLicensePublicKey: options.verification.gumLicensePublicKey,
              sessionSecret: options.verification.sessionSecret,
            },
          }
        : undefined,
    };
  });
}

export interface TestResponse {
  status: number;
  headers: Headers;
  body: any;
}

/** Minimal request helper for a Hono app (replaces supertest). */
export function client(app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }) {
  async function send(path: string, init?: RequestInit): Promise<TestResponse> {
    const res = await app.request(path, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    return { status: res.status, headers: res.headers, body };
  }
  return {
    get(path: string, query: Record<string, string | number> = {}, headers: Record<string, string> = {}) {
      const params = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
      const qs = params.toString();
      return send(qs ? `${path}?${qs}` : path, { headers });
    },
    post(path: string, body: unknown, headers: Record<string, string> = {}) {
      return send(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    },
  };
}
