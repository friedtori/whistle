import { canonicalUrl, parsePlatformFromUrl } from "../ids.ts";
import { asArray, asNumber, asRecord, asString, httpJson, sleep } from "../http.ts";
import { searchWithPlainFallback } from "./search.ts";
import type { MusicBrainzProvider, SearchQuery, TrackHit, UrlRelation } from "../types.ts";

interface MbRecording {
  id?: string;
  title?: string;
  length?: number;
  isrcs?: string[];
  "artist-credit"?: Array<{ name?: string; artist?: { name?: string } }>;
  relations?: Array<{
    type?: string;
    url?: { resource?: string };
    recording?: { id?: string; title?: string; length?: number };
  }>;
}

export function createMusicBrainzProvider(userAgent: string): MusicBrainzProvider {
  const limiter = createLimiter(1100);

  async function mbGet<T>(path: string): Promise<T | null> {
    return limiter(async () => {
      const res = await httpJson<T>(`https://musicbrainz.org/ws/2/${path}`, {
        headers: { "User-Agent": userAgent, Accept: "application/json" },
      });
      return res.ok ? res.json : null;
    });
  }

  return {
    platform: "musicbrainz",
    enabled: true,
    supportsIsrcLookup: true,
    async getById(id) {
      const json = await mbGet<MbRecording>(
        `recording/${encodeURIComponent(id)}?inc=isrcs+artist-credits+url-rels&fmt=json`,
      );
      return json ? toHit(json) : null;
    },
    async getByIsrc(isrc) {
      const json = await mbGet<{ recordings?: MbRecording[] }>(
        `isrc/${encodeURIComponent(isrc)}?inc=artist-credits+isrcs&fmt=json`,
      );
      const recordings = asArray(json?.recordings) as MbRecording[];
      const first = recordings[0];
      return first ? toHit(first, isrc) : null;
    },
    async search(query: SearchQuery) {
      const parts = [`recording:"${escapeLucene(query.title)}"`];
      if (query.artists[0]) parts.push(`artist:"${escapeLucene(query.artists[0])}"`);
      if (query.duration_ms != null) {
        const lo = Math.max(0, query.duration_ms - 2000);
        const hi = query.duration_ms + 2000;
        parts.push(`dur:[${lo} TO ${hi}]`);
      }
      const fetchHits = async (q: string) => {
        const json = await mbGet<{ recordings?: MbRecording[] }>(
          `recording?query=${encodeURIComponent(q)}&limit=8&fmt=json`,
        );
        return asArray(json?.recordings)
          .map((item) => toHit(item as MbRecording))
          .filter((x): x is TrackHit => x !== null);
      };
      return searchWithPlainFallback(query, parts.join(" AND "), fetchHits);
    },
    async getByUrl(url) {
      const variants = urlVariants(url);
      for (const resource of variants) {
        const json = await mbGet<{
          relations?: MbRecording["relations"];
        }>(`url?resource=${encodeURIComponent(resource)}&inc=recording-rels&fmt=json`);
        const rels = asArray(json?.relations) as NonNullable<MbRecording["relations"]>;
        const rec = rels.find((rel) => rel.recording?.id)?.recording;
        if (rec?.id) {
          const full = await this.getById(rec.id);
          if (full) return full;
        }
      }
      return null;
    },
    async getUrlRelations(mbid) {
      const json = await mbGet<MbRecording>(
        `recording/${encodeURIComponent(mbid)}?inc=url-rels+isrcs+artist-credits&fmt=json`,
      );
      if (!json) return { relations: [], isrcs: [] };
      const relations: UrlRelation[] = [];
      for (const rel of json.relations ?? []) {
        const resource = asString(rel.url?.resource);
        if (!resource) continue;
        const parsed = parsePlatformFromUrl(resource);
        if (parsed) relations.push(parsed);
      }
      return { relations, isrcs: normalizeIsrcList(json.isrcs) };
    },
  };
}

function toHit(raw: MbRecording, isrc?: string): TrackHit | null {
  const id = asString(raw.id);
  const title = asString(raw.title);
  if (!id || !title) return null;
  const artists = (raw["artist-credit"] ?? [])
    .map((credit) => asString(credit.name) ?? asString(credit.artist?.name))
    .filter((name): name is string => Boolean(name));
  const isrcs = normalizeIsrcList(raw.isrcs);
  const primary = isrc ? normalizeIsrcValue(isrc) : (isrcs[0] ?? null);
  if (primary && !isrcs.includes(primary)) isrcs.unshift(primary);
  return {
    platform: "musicbrainz",
    id,
    url: canonicalUrl("musicbrainz", id),
    title,
    artists,
    duration_ms: asNumber(raw.length),
    isrc: primary,
    isrcs,
    mbid: id,
  };
}

function normalizeIsrcValue(value: string): string {
  return value.toUpperCase().replace(/[-\s]/g, "");
}

function normalizeIsrcList(values: string[] | undefined): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const normalized = normalizeIsrcValue(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function escapeLucene(value: string): string {
  return value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1");
}

function urlVariants(url: string): string[] {
  const values = new Set<string>([url]);
  try {
    const u = new URL(url);
    values.add(u.toString());
    values.add(`https://www.${u.hostname.replace(/^www\./, "")}${u.pathname}${u.search}`);
    values.add(`https://${u.hostname.replace(/^www\./, "")}${u.pathname}${u.search}`);
  } catch {
    // ignore
  }
  return [...values];
}

function createLimiter(minIntervalMs: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain = Promise.resolve();
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(async () => {
      const started = Date.now();
      try {
        return await fn();
      } finally {
        const wait = minIntervalMs - (Date.now() - started);
        if (wait > 0) await sleep(wait);
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
