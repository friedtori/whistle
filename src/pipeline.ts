import type { Store } from "./db.ts";
import { pickFuzzyMatch } from "./fuzzy.ts";
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
  isrc_from_fuzzy: 0.8 * 0.98,
  mb_relation: 0.9,
  user: 1,
} as const;

type IsrcOrigin = "trusted" | "fuzzy";

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
    parsed.kind === source.platform ? 1 : undefined,
  );

  const sourceMethod = methodForSource(parsed.kind, source);
  const isrcs = new IsrcBag();
  if (parsed.kind === "isrc") isrcs.add([parsed.value], "trusted");
  isrcs.add(
    collectIsrcs(source),
    sourceMethod === "fuzzy" || parsed.kind === "query" ? "fuzzy" : "trusted",
  );
  for (const isrc of isrcs.trusted()) deps.db.addIdentifier(recording.id, "isrc", isrc);

  const triedIsrcs = new Set<string>();
  await runIsrcStage(deps, recording.id, isrcs, triedIsrcs);
  await runMbStage(deps, recording.id, isrcs, source);
  await runIsrcStage(deps, recording.id, isrcs, triedIsrcs);
  await runFuzzyStage(deps, recording.id, source);
  await runSpotifyLast(deps, recording.id, isrcs, source, triedIsrcs);
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
  if (method !== "fuzzy" && method !== "isrc_from_fuzzy") {
    for (const isrc of collectIsrcs(hit)) {
      db.addIdentifier(recordingId, "isrc", isrc);
    }
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
  parsed: { artist?: string; title?: string; album?: string; duration_ms?: number },
  providers: ProviderMap,
): Promise<TrackHit | null> {
  const artist = parsed.artist?.trim() ?? "";
  const title = parsed.title?.trim() ?? "";
  const album = parsed.album?.trim() || undefined;
  const duration_ms = parsed.duration_ms ?? null;
  if (!artist || !title || duration_ms == null) return null;

  const probe = { title, artists: [artist], duration_ms, album };
  for (const platform of SEARCH_BOOTSTRAP) {
    const provider = providers[platform];
    if (!provider.enabled) continue;
    try {
      const hits = await provider.search({
        title,
        artists: [artist],
        duration_ms,
        acceptHits: (candidates) =>
          pickFuzzyMatch(probe, candidates) !== null,
      });
      const picked = pickFuzzyMatch(probe, hits);
      if (picked) return picked.hit;
    } catch (err) {
      warn(platform, "search", err);
    }
  }
  return null;
}

async function runIsrcStage(
  deps: ResolveDeps,
  recordingId: string,
  isrcs: IsrcBag,
  tried: Set<string>,
): Promise<void> {
  if (isrcs.size === 0) return;
  for (const platform of ISRC_STAGE) {
    if (hasMatch(deps.db, recordingId, platform)) continue;
    const provider = deps.providers[platform];
    if (!provider.enabled || !provider.supportsIsrcLookup) continue;
    const trusted = await firstIsrcHit(provider, isrcs.trusted(), platform, tried);
    if (trusted) {
      rememberHit(deps.db, recordingId, trusted, "isrc");
      isrcs.add(collectIsrcs(trusted), "trusted");
      continue;
    }
    const derived = await firstIsrcHit(provider, isrcs.fuzzy(), platform, tried);
    if (derived) {
      rememberHit(deps.db, recordingId, derived, "isrc_from_fuzzy");
      isrcs.add(collectIsrcs(derived), "fuzzy");
    }
  }
}

async function runMbStage(
  deps: ResolveDeps,
  recordingId: string,
  isrcs: IsrcBag,
  source: TrackHit,
): Promise<void> {
  const mb = deps.providers.musicbrainz;
  if (!mb.enabled) return;

  let recording = deps.db.findRecordingById(recordingId)!;
  let mbid = recording.mbid;
  let mbOrigin: IsrcOrigin | null = mbid ? "trusted" : null;

  if (!mbid) {
    for (const isrc of isrcs.trusted()) {
      try {
        const hit = await mb.getByIsrc(isrc);
        if (hit?.mbid) {
          rememberHit(deps.db, recordingId, hit, "isrc");
          isrcs.add(collectIsrcs(hit), "trusted");
          mbid = hit.mbid;
          mbOrigin = "trusted";
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
        acceptHits: (candidates) => pickFuzzyMatch(source, candidates) !== null,
      });
      const picked = pickFuzzyMatch(source, hits);
      if (picked) {
        rememberHit(deps.db, recordingId, picked.hit, "fuzzy", picked.confidence);
        isrcs.add(collectIsrcs(picked.hit), "fuzzy");
        mbid = picked.hit.mbid ?? picked.hit.id;
        mbOrigin = "fuzzy";
      }
    } catch (err) {
      warn("musicbrainz", "search", err);
    }
  }

  if (!mbid) return;

  try {
    const { relations, isrcs: siblingIsrcs } = await mb.getUrlRelations(mbid);
    isrcs.add(siblingIsrcs, mbOrigin ?? "fuzzy");
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
    artists: recording.artists.length ? recording.artists : source.artists,
    duration_ms: recording.duration_ms ?? source.duration_ms,
    album: source.album,
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
        acceptHits: (candidates) => pickFuzzyMatch(probe, candidates) !== null,
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
  isrcs: IsrcBag,
  source: TrackHit,
  tried: Set<string>,
): Promise<void> {
  if (hasMatch(deps.db, recordingId, "spotify")) return;
  const provider = deps.providers.spotify;
  if (!provider.enabled) return;

  if (provider.supportsIsrcLookup) {
    const trusted = await firstIsrcHit(provider, isrcs.trusted(), "spotify", tried);
    if (trusted) {
      rememberHit(deps.db, recordingId, trusted, "isrc");
      return;
    }
    const derived = await firstIsrcHit(provider, isrcs.fuzzy(), "spotify", tried);
    if (derived) {
      rememberHit(deps.db, recordingId, derived, "isrc_from_fuzzy");
      return;
    }
  }

  const recording = deps.db.findRecordingById(recordingId)!;
  try {
    const probe = {
      title: recording.title || source.title,
      artists: recording.artists.length ? recording.artists : source.artists,
      duration_ms: recording.duration_ms ?? source.duration_ms,
      album: source.album,
    };
    const hits = await provider.search({
      title: probe.title,
      artists: recording.artists.length ? recording.artists : source.artists,
      duration_ms: probe.duration_ms,
      acceptHits: (candidates) => pickFuzzyMatch(probe, candidates) !== null,
    });
    const picked = pickFuzzyMatch(probe, hits);
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
      skip_reason: provider.skipReason?.() ?? (provider.enabled ? "unmatched" : "credentials_missing"),
    });
  }
}

function collectIsrcs(hit: TrackHit): string[] {
  return uniqueIsrcs([hit.isrc, ...(hit.isrcs ?? [])]);
}

class IsrcBag {
  private readonly origins = new Map<string, IsrcOrigin>();

  get size(): number {
    return this.origins.size;
  }

  add(values: Array<string | null | undefined> | string[], origin: IsrcOrigin): void {
    for (const value of uniqueIsrcs(values)) {
      if (this.origins.get(value) === "trusted") continue;
      this.origins.set(value, origin);
    }
  }

  trusted(): string[] {
    return this.list("trusted");
  }

  fuzzy(): string[] {
    return this.list("fuzzy");
  }

  private list(origin: IsrcOrigin): string[] {
    return [...this.origins.entries()].filter(([, value]) => value === origin).map(([isrc]) => isrc);
  }
}

function uniqueIsrcs(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const normalized = value.toUpperCase().replace(/[-\s]/g, "");
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function hasMatch(db: Store, recordingId: string, platform: Platform): boolean {
  return db.listLinks(recordingId).some((link) => link.platform === platform && !link.unmatched);
}

async function firstIsrcHit(
  provider: Provider,
  isrcs: string[],
  platform: Platform,
  tried: Set<string>,
): Promise<TrackHit | null> {
  for (const isrc of isrcs) {
    const key = `${platform}:${isrc}`;
    if (tried.has(key)) continue;
    tried.add(key);
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
