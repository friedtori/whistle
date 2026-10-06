import type { Config } from "../config.ts";
import { hasSpotifyAuth } from "../config.ts";
import { canonicalUrl } from "../ids.ts";
import { asArray, asNumber, asString, httpJson } from "../http.ts";
import type { Provider, SearchQuery, TrackHit } from "../types.ts";

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

export function createSpotifyProvider(config: Config): Provider {
  let token: TokenState | null = null;

  async function bearer(): Promise<string | null> {
    if (!hasSpotifyAuth(config)) return null;
    if (token && token.expiresAt > Date.now() + 30_000) return token.accessToken;
    const basic = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString(
      "base64",
    );
    const res = await httpJson<{ access_token?: string; expires_in?: number }>(
      "https://accounts.spotify.com/api/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      },
    );
    const access = asString(res.json?.access_token);
    if (!access) return null;
    token = {
      accessToken: access,
      expiresAt: Date.now() + (res.json?.expires_in ?? 3600) * 1000,
    };
    return access;
  }

  async function spotifyGet<T>(path: string): Promise<T | null> {
    const access = await bearer();
    if (!access) return null;
    const res = await httpJson<T>(`https://api.spotify.com/v1${path}`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    return res.ok ? res.json : null;
  }

  return {
    platform: "spotify",
    enabled: hasSpotifyAuth(config),
    supportsIsrcLookup: true,
    async getById(id) {
      const json = await spotifyGet<SpotifyTrack>(`/tracks/${encodeURIComponent(id)}`);
      return json ? fromTrack(json) : null;
    },
    async getByIsrc(isrc) {
      const json = await spotifyGet<{ tracks?: { items?: SpotifyTrack[] } }>(
        `/search?q=${encodeURIComponent(`isrc:${isrc}`)}&type=track&limit=5`,
      );
      return fromTrack(json?.tracks?.items?.[0] ?? null);
    },
    async search(query: SearchQuery) {
      const q = `track:${query.title} artist:${query.artists[0] ?? ""}`;
      const json = await spotifyGet<{ tracks?: { items?: SpotifyTrack[] } }>(
        `/search?q=${encodeURIComponent(q)}&type=track&limit=8`,
      );
      return asArray(json?.tracks?.items)
        .map((item) => fromTrack(item as SpotifyTrack))
        .filter((x): x is TrackHit => x !== null);
    },
  };
}

interface SpotifyTrack {
  id?: string;
  name?: string;
  duration_ms?: number;
  external_ids?: { isrc?: string };
  external_urls?: { spotify?: string };
  artists?: Array<{ name?: string }>;
}

function fromTrack(raw: SpotifyTrack | null): TrackHit | null {
  if (!raw?.id || !raw.name) return null;
  return {
    platform: "spotify",
    id: raw.id,
    url: asString(raw.external_urls?.spotify) ?? canonicalUrl("spotify", raw.id),
    title: raw.name,
    artists: (raw.artists ?? []).map((a) => a.name).filter((n): n is string => Boolean(n)),
    duration_ms: asNumber(raw.duration_ms),
    isrc: asString(raw.external_ids?.isrc),
  };
}
