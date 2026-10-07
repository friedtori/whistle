import type { Config } from "../config.ts";
import { hasTidalAuth } from "../config.ts";
import { canonicalUrl } from "../ids.ts";
import { asArray, asNumber, asRecord, asString, httpJson } from "../http.ts";
import type { Provider, SearchQuery, TrackHit } from "../types.ts";

interface TokenState {
  accessToken: string;
  expiresAt: number;
}

export function createTidalProvider(config: Config, request: typeof httpJson = httpJson): Provider {
  let token: TokenState | null = null;

  async function bearer(): Promise<string | null> {
    if (!hasTidalAuth(config)) return null;
    if (token && token.expiresAt > Date.now() + 30_000) return token.accessToken;
    const basic = Buffer.from(`${config.tidalClientId}:${config.tidalClientSecret}`).toString(
      "base64",
    );
    const res = await request<{ access_token?: string; expires_in?: number }>(
      "https://auth.tidal.com/v1/oauth2/token",
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

  async function tidalGet<T>(path: string): Promise<T | null> {
    const access = await bearer();
    if (!access) return null;
    const res = await request<T>(`https://openapi.tidal.com/v2${path}`, {
      headers: {
        Authorization: `Bearer ${access}`,
        Accept: "application/vnd.api+json",
      },
    });
    return res.ok ? res.json : null;
  }

  return {
    platform: "tidal",
    enabled: hasTidalAuth(config),
    supportsIsrcLookup: true,
    async getById(id) {
      const json = await tidalGet<TidalDoc>(
        `/tracks/${encodeURIComponent(id)}?countryCode=${config.tidalCountry}&include=artists`,
      );
      return json ? fromDoc(json, id) : null;
    },
    async getByIsrc(isrc) {
      const json = await tidalGet<TidalDoc>(
        `/tracks?countryCode=${config.tidalCountry}&filter[isrc]=${encodeURIComponent(isrc)}&include=artists`,
      );
      const id = firstId(json);
      return json && id ? fromDoc(json, id) : null;
    },
    async search(query: SearchQuery) {
      const q = `${query.artists[0] ?? ""} ${query.title}`.trim();
      const params = new URLSearchParams({
        "filter[query]": q,
        countryCode: config.tidalCountry,
        include: "tracks,tracks.artists",
      });
      const json = await tidalGet<TidalDoc>(
        `/searchResults?${params}`,
      );
      if (!json) return [];
      const results = Array.isArray(json.data) ? json.data : json.data ? [json.data] : [];
      const relationships = results.map((result) =>
        asRecord(asRecord(asRecord(result)?.relationships)?.tracks),
      );
      const trackIds = relationships.flatMap((relationship) => asArray(relationship?.data));
      const includedTracks = asArray(json.included).filter(
        (item) => asRecord(item)?.type === "tracks",
      );
      // Relationship order is search rank; included resources need not be
      // ordered and can contain unrelated tracks. Only fall back when linkage
      // is absent, not when the API explicitly returns an empty track list.
      const candidates = relationships.some((relationship) => Array.isArray(relationship?.data))
        ? trackIds
        : results.length ? includedTracks : [];
      const hits: TrackHit[] = [];
      const seen = new Set<string>();
      for (const item of candidates) {
        const rec = asRecord(item);
        const id = asString(rec?.id);
        if (rec?.type !== "tracks" || !id || seen.has(id)) continue;
        seen.add(id);
        const hit = fromDoc(json, id) ?? fromResource(rec, json.included);
        if (hit) hits.push(hit);
      }
      return hits.slice(0, 8);
    },
  };
}

interface TidalDoc {
  data?: unknown;
  included?: unknown[];
}

function firstId(doc: TidalDoc | null): string | null {
  if (!doc) return null;
  if (Array.isArray(doc.data)) return asString(asRecord(doc.data[0])?.id);
  return asString(asRecord(doc.data)?.id);
}

function fromDoc(doc: TidalDoc, id: string): TrackHit | null {
  const resources = [
    ...(Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : []),
    ...asArray(doc.included),
  ];
  const match = resources.map(asRecord).find((item) => item?.id === id && item.type === "tracks");
  return fromResource(match ?? null, doc.included);
}

function fromResource(resource: Record<string, unknown> | null, included?: unknown[]): TrackHit | null {
  if (!resource) return null;
  const id = asString(resource.id);
  const attrs = asRecord(resource.attributes);
  const title = asString(attrs?.title);
  if (!id || !title) return null;
  const artists = artistNames(resource, included);
  const duration = durationMs(attrs);
  return {
    platform: "tidal",
    id,
    url: canonicalUrl("tidal", id),
    title,
    artists,
    duration_ms: duration,
    isrc: asString(attrs?.isrc),
  };
}

function artistNames(resource: Record<string, unknown>, included?: unknown[]): string[] {
  const rel = asRecord(asRecord(resource.relationships)?.artists);
  const refs = asArray(rel?.data) as Array<{ id?: string }>;
  const names: string[] = [];
  for (const ref of refs) {
    const artist = asArray(included)
      .map(asRecord)
      .find((item) => item?.type === "artists" && item.id === ref.id);
    const name = asString(asRecord(artist?.attributes)?.name);
    if (name) names.push(name);
  }
  return names;
}

function durationMs(attrs: Record<string, unknown> | null): number | null {
  if (!attrs) return null;
  const duration = attrs.duration;
  if (typeof duration === "number") {
    return duration > 10000 ? duration : duration * 1000;
  }
  if (typeof duration === "string") {
    if (duration.startsWith("PT")) {
      const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(duration);
      if (!m) return null;
      return Math.round(
        (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000,
      );
    }
    const n = Number(duration);
    return Number.isFinite(n) ? (n > 10000 ? n : n * 1000) : null;
  }
  return asNumber(attrs.durationInMs) ?? asNumber(attrs.durationInMillis);
}
