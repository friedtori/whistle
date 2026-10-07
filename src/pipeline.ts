import type { Store } from "./db.ts";
import { artistOverlaps, pickFuzzyMatch } from "./fuzzy.ts";
import { HttpError, canonicalUrl, parseInput } from "./ids.ts";
import type {
  IdentifierKind,
  MatchMethod,
  Platform,
  PlatformLink,
  Provider,
  ProviderMap,
  Recording,
  ResolveQuery,
  ResolveResponse,
  TrackHit,
} from "./types.ts";
import { PLATFORMS } from "./types.ts";

const ISRC_STAGE: Platform[] = ["deezer", "apple", "tidal", "musicbrainz"];
const FUZZY_STAGE: Platform[] = ["deezer", "apple", "tidal", "ytm", "musicbrainz"];
const SEARCH_BOOTSTRAP: Platform[] = ["deezer", "apple", "tidal"];

const CONFIDENCE = {
  isrc: 0.98,
  mb_relation: 0.9,
  user: 1,
} as const;

export interface ResolveDeps {
  db: Store;
  providers: ProviderMap;
}

export async function resolveTrack(query: ResolveQuery, deps: ResolveDeps): Promise<ResolveResponse> {
  const parsed = parseInput(query);
  const cached = deps.db.findRecordingByIdentifier(parsed.kind, parsed.value);
  if (cached) {
    return present(deps.db, cached, true);
  }

  const source =
    parsed.kind === "query"
      ? await bootstrapFromSearch(parsed, deps.providers)
      : await fetchSource(
          { kind: parsed.kind, value: parsed.value, url: parsed.url },
          deps.providers,
        );
  if (!source) {
    throw new HttpError(
      404,
      "not_found",
      parsed.kind === "query"
        ? `No fuzzy match for "${parsed.artist} – ${parsed.title}"`
        : `Could not resolve ${parsed.kind}:${parsed.value}`,
    );
  }

  const recording = findOrCreateRecording(deps.db, source);
  deps.db.addIdentifier(recording.id, parsed.kind, parsed.value);
  rememberHit(
    deps.db,
    recording.id,
    source,
    methodForSource(parsed.kind, source),
    parsed.kind === source.platform || parsed.kind === "isrc" ? 1 : undefined,
  );

  const isrcs = new Set<string>();
  if (parsed.kind === "isrc") isrcs.add(parsed.value);
  if (source.isrc) {
    const normalized = source.isrc.toUpperCase().replace(/[-\s]/g, "");
    isrcs.add(normalized);
    deps.db.addIdentifier(recording.id, "isrc", normalized);
  }

  await runIsrcStage(deps, recording.id, isrcs);
  await runMbStage(deps, recording.id, isrcs, source);
  await runFuzzyStage(deps, recording.id, source);
  await runSpotifyLast(deps, recording.id, isrcs, source);
  fillUnmatched(deps, recording.id);

  const latest = deps.db.findRecordingById(recording.id)!;
  return present(deps.db, latest, false);
}

async function fetchSource(
  parsed: { kind: Exclude<IdentifierKind, "query">; value: string; url?: string },
  providers: ProviderMap,
): Promise<TrackHit | null> {
  if (parsed.kind === "isrc") {
    for (const platform of [...ISRC_STAGE, "spotify"] as Platform[]) {
      const provider = providers[platform];
      if (!provider.enabled || !provider.supportsIsrcLookup) continue;
      try {
        const hit = await provider.getByIsrc(parsed.value);
        if (hit) return hit;
      } catch (err) {
        warn(platform, "getByIsrc", err);
      }
    }
    return null;
  }

  const provider = providers[parsed.kind];
  if (provider.enabled) {
    try {
      const hit = await provider.getById(parsed.value);
      if (hit) return hit;
    } catch (err) {
      warn(parsed.kind, "getById", err);
    }
  }

  const url = parsed.url ?? canonicalUrl(parsed.kind, parsed.value);
  try {
    const viaMb = await providers.musicbrainz.getByUrl(url);
    if (viaMb) return viaMb;
  } catch (err) {
    warn("musicbrainz", "getByUrl", err);
  }
  return null;
}

function findOrCreateRecording(db: Store, source: TrackHit) {
  if (source.isrc) {
    const byIsrc = db.findRecordingByIdentifier("isrc", source.isrc.toUpperCase().replace(/[-\s]/g, ""));
    if (byIsrc) return byIsrc;
  }
  if (source.mbid) {
    const byMbid = db.findRecordingByMbid(source.mbid) ?? db.findRecordingByIdentifier("musicbrainz", source.mbid);
    if (byMbid) {
      if (!byMbid.mbid) db.updateRecording(byMbid.id, { mbid: source.mbid });
      return byMbid;
    }
  }
  if (source.platform !== "musicbrainz") {
    const byId = db.findRecordingByIdentifier(source.platform, source.id);
    if (byId) return byId;
  }
  return db.createRecording({
    title: source.title,
    artists: source.artists,
    duration_ms: source.duration_ms,
    mbid: source.mbid ?? null,
  });
}

function rememberHit(
  db: Store,
  recordingId: string,
  hit: TrackHit,
  method: MatchMethod,
  confidence?: number,
): void {
  if (hit.platform !== "musicbrainz") {
    db.addIdentifier(recordingId, hit.platform, hit.id);
  } else {
    db.addIdentifier(recordingId, "musicbrainz", hit.id);
    db.updateRecording(recordingId, { mbid: hit.id });
  }
  if (hit.isrc) {
    db.addIdentifier(recordingId, "isrc", hit.isrc.toUpperCase().replace(/[-\s]/g, ""));
  }
  if (hit.mbid) db.updateRecording(recordingId, { mbid: hit.mbid });
  const resolvedConfidence =
    confidence ?? (method === "fuzzy" ? 0.65 : CONFIDENCE[method as keyof typeof CONFIDENCE] ?? 0.9);
  db.upsertLink({
    recordingId,
    platform: hit.platform,
    url: hit.url,
    duration_ms: hit.duration_ms,
    confidence: resolvedConfidence,
    method,
    unmatched: false,
  });
}

function methodForSource(kind: IdentifierKind, source: TrackHit): MatchMethod {
  if (kind === "query") return "fuzzy";
  if (kind === "isrc") return "isrc";
  if (source.platform === "musicbrainz" && kind !== "musicbrainz") return "mb_relation";
  if (kind === source.platform) return "isrc";
  return "mb_relation";
}

async function bootstrapFromSearch(
  parsed: { artist?: string; title?: string; duration_ms?: number },
  providers: ProviderMap,
): Promise<TrackHit | null> {
  const artist = parsed.artist?.trim() ?? "";
  const title = parsed.title?.trim() ?? "";
  const duration_ms = parsed.duration_ms ?? null;
  if (!artist || !title || duration_ms == null) return null;

  const probe = { title, duration_ms };
  for (const platform of SEARCH_BOOTSTRAP) {
    const provider = providers[platform];
    if (!provider.enabled) continue;
    try {
      const hits = await provider.search({
        title,
        artists: [artist],
        duration_ms,
      });
      const withArtist = hits.filter((hit) => artistOverlaps(artist, hit.artists));
      const picked = pickFuzzyMatch(probe, withArtist);
      if (picked) return picked.hit;
    } catch (err) {
      warn(platform, "search", err);
    }
  }
  return null;
}

async function runIsrcStage(deps: ResolveDeps, recordingId: string, isrcs: Set<string>): Promise<void> {
  if (isrcs.size === 0) return;
  for (const platform of ISRC_STAGE) {
    if (hasMatch(deps.db, recordingId, platform)) continue;
    const provider = deps.providers[platform];
    if (!provider.enabled || !provider.supportsIsrcLookup) continue;
    const hit = await firstIsrcHit(provider, isrcs, platform);
    if (hit) {
      rememberHit(deps.db, recordingId, hit, "isrc");
      if (hit.isrc) isrcs.add(hit.isrc.toUpperCase().replace(/[-\s]/g, ""));
    }
  }
}

async function runMbStage(
  deps: ResolveDeps,
  recordingId: string,
  isrcs: Set<string>,
  source: TrackHit,
): Promise<void> {
  const mb = deps.providers.musicbrainz;
  if (!mb.enabled) return;

  let recording = deps.db.findRecordingById(recordingId)!;
  let mbid = recording.mbid;

  if (!mbid) {
    for (const isrc of isrcs) {
      try {
        const hit = await mb.getByIsrc(isrc);
        if (hit?.mbid) {
          rememberHit(deps.db, recordingId, hit, "isrc");
          mbid = hit.mbid;
          break;
        }
      } catch (err) {
        warn("musicbrainz", "getByIsrc", err);
      }
    }
  }

  if (!mbid) {
    try {
      const hits = await mb.search({
        title: source.title,
        artists: source.artists,
        duration_ms: source.duration_ms,
      });
      const picked = pickFuzzyMatch(source, hits);
      if (picked) {
        rememberHit(deps.db, recordingId, picked.hit, "fuzzy", picked.confidence);
        mbid = picked.hit.mbid ?? picked.hit.id;
      }
    } catch (err) {
      warn("musicbrainz", "search", err);
    }
  }

  if (!mbid) return;

  try {
    const relations = await mb.getUrlRelations(mbid);
    for (const rel of relations) {
      if (hasMatch(deps.db, recordingId, rel.platform)) continue;
      deps.db.addIdentifier(recordingId, rel.platform, rel.id);
      deps.db.upsertLink({
        recordingId,
        platform: rel.platform,
        url: rel.url,
        duration_ms: source.duration_ms,
        confidence: CONFIDENCE.mb_relation,
        method: "mb_relation",
        unmatched: false,
      });
    }
  } catch (err) {
    warn("musicbrainz", "getUrlRelations", err);
  }

  recording = deps.db.findRecordingById(recordingId)!;
  if (recording.mbid && !hasMatch(deps.db, recordingId, "musicbrainz")) {
    deps.db.upsertLink({
      recordingId,
      platform: "musicbrainz",
      url: canonicalUrl("musicbrainz", recording.mbid),
      duration_ms: recording.duration_ms,
      confidence: CONFIDENCE.isrc,
      method: "isrc",
      unmatched: false,
    });
  }
}

async function runFuzzyStage(deps: ResolveDeps, recordingId: string, source: TrackHit): Promise<void> {
  const recording = deps.db.findRecordingById(recordingId)!;
  const probe = {
    title: recording.title || source.title,
    duration_ms: recording.duration_ms ?? source.duration_ms,
  };
  for (const platform of FUZZY_STAGE) {
    if (hasMatch(deps.db, recordingId, platform)) continue;
    const provider = deps.providers[platform];
    if (!provider.enabled) continue;
    try {
      const hits = await provider.search({
        title: probe.title,
        artists: recording.artists.length ? recording.artists : source.artists,
        duration_ms: probe.duration_ms,
      });
      const picked = pickFuzzyMatch(probe, hits);
      if (picked) rememberHit(deps.db, recordingId, picked.hit, "fuzzy", picked.confidence);
    } catch (err) {
      warn(platform, "search", err);
    }
  }
}

async function runSpotifyLast(
  deps: ResolveDeps,
  recordingId: string,
  isrcs: Set<string>,
  source: TrackHit,
): Promise<void> {
  if (hasMatch(deps.db, recordingId, "spotify")) return;
  const provider = deps.providers.spotify;
  if (!provider.enabled) return;

  if (isrcs.size > 0 && provider.supportsIsrcLookup) {
    const hit = await firstIsrcHit(provider, isrcs, "spotify");
    if (hit) {
      rememberHit(deps.db, recordingId, hit, "isrc");
      return;
    }
  }

  const recording = deps.db.findRecordingById(recordingId)!;
  try {
    const hits = await provider.search({
      title: recording.title || source.title,
      artists: recording.artists.length ? recording.artists : source.artists,
      duration_ms: recording.duration_ms ?? source.duration_ms,
    });
    const picked = pickFuzzyMatch(
      { title: recording.title || source.title, duration_ms: recording.duration_ms ?? source.duration_ms },
      hits,
    );
    if (picked) rememberHit(deps.db, recordingId, picked.hit, "fuzzy", picked.confidence);
  } catch (err) {
    warn("spotify", "search", err);
  }
}

function fillUnmatched(deps: ResolveDeps, recordingId: string): void {
  const existing = new Map(deps.db.listLinks(recordingId).map((link) => [link.platform, link]));
  for (const platform of PLATFORMS) {
    if (existing.get(platform) && !existing.get(platform)!.unmatched) continue;
    const provider = deps.providers[platform];
    deps.db.upsertLink({
      recordingId,
      platform,
      url: null,
      duration_ms: null,
      confidence: 0,
      method: null,
      unmatched: true,
      skip_reason: provider.enabled ? "unmatched" : "credentials_missing",
    });
  }
}

function hasMatch(db: Store, recordingId: string, platform: Platform): boolean {
  return db.listLinks(recordingId).some((link) => link.platform === platform && !link.unmatched);
}

async function firstIsrcHit(
  provider: Provider,
  isrcs: Set<string>,
  platform: Platform,
): Promise<TrackHit | null> {
  for (const isrc of isrcs) {
    try {
      const hit = await provider.getByIsrc(isrc);
      if (hit) return hit;
    } catch (err) {
      warn(platform, "getByIsrc", err);
    }
  }
  return null;
}

function present(db: Store, recording: Recording, cached: boolean): ResolveResponse {
  const identifiers = db.listIdentifiers(recording.id).map(({ kind, value }) => ({ kind, value }));
  const links = completeLinks(db.listLinks(recording.id));
  return {
    recording: {
      id: recording.id,
      title: recording.title,
      artists: recording.artists,
      duration_ms: recording.duration_ms,
      mbid: recording.mbid,
    },
    identifiers,
    links,
    cached,
  };
}

function completeLinks(links: PlatformLink[]): PlatformLink[] {
  const byPlatform = new Map(links.map((link) => [link.platform, link]));
  return PLATFORMS.map((platform) => {
    const link = byPlatform.get(platform);
    if (link) return link;
    return {
      id: `missing-${platform}`,
      recording_id: links[0]?.recording_id ?? "",
      platform,
      url: null,
      duration_ms: null,
      confidence: 0,
      method: null,
      verified_at: new Date().toISOString(),
      unmatched: true,
      skip_reason: "unmatched",
    };
  });
}

function warn(platform: string, op: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[whistle] ${platform}.${op} failed: ${message}`);
}
