import type { TrackHit } from "./types.ts";

const DURATION_GATE_MS = 2000;
const TITLE_MATCH_THRESHOLD = 0.8;
const ARTIST_MATCH_THRESHOLD = 0.8;

const VERSION_FAMILIES: Array<{ family: string; pattern: RegExp }> = [
  { family: "live", pattern: /\blive\b/i },
  { family: "remix", pattern: /\b(?:re-?mix(?:ed)?|rmx)\b/i },
  { family: "edit", pattern: /\b(?:re-?edits?|edits?)\b/i },
  { family: "remaster", pattern: /\bre-?masters?(?:ed)?\b/i },
  { family: "acoustic", pattern: /\bacoustic\b/i },
  { family: "instrumental", pattern: /\binstrumental\b/i },
  { family: "karaoke", pattern: /\bkaraoke\b/i },
  { family: "cover", pattern: /\bcover\b/i },
  { family: "demo", pattern: /\bdemo\b/i },
  { family: "session", pattern: /\bsession\b/i },
];

const ARTIST_STOP_WORDS = new Set(["the", "a", "an", "and", "of", "feat", "ft", "featuring"]);

export function versionFamilies(title: string): Set<string> {
  const found = new Set<string>();
  for (const { family, pattern } of VERSION_FAMILIES) {
    if (pattern.test(title)) found.add(family);
  }
  return found;
}

export function versionKeywordsConflict(sourceTitle: string, candidateTitle: string): boolean {
  const a = versionFamilies(sourceTitle);
  const b = versionFamilies(candidateTitle);
  if (a.size !== b.size) return true;
  for (const family of a) {
    if (!b.has(family)) return true;
  }
  // Family equality is insufficient: two named remixes or live venues may
  // represent different recordings. Ignore punctuation and spelling aliases,
  // but retain every word of the version-bearing title.
  if (a.size > 0 && versionTitle(sourceTitle) !== versionTitle(candidateTitle)) return true;
  return false;
}

function versionTitle(title: string): string {
  let normalized = title;
  for (const { family, pattern } of VERSION_FAMILIES) {
    normalized = normalized.replace(new RegExp(pattern.source, "gi"), family);
  }
  return normalizeTitle(normalized);
}

export function durationWithinGate(
  sourceMs: number | null | undefined,
  candidateMs: number | null | undefined,
  gateMs = DURATION_GATE_MS,
): boolean {
  if (
    sourceMs == null || candidateMs == null ||
    !Number.isFinite(sourceMs) || !Number.isFinite(candidateMs) ||
    sourceMs <= 0 || candidateMs <= 0
  ) return false;
  return Math.abs(sourceMs - candidateMs) <= gateMs;
}

export function normalizeTitle(title: string): string {
  // Strip only explicit featured-artist credits; parentheses can contain
  // meaningful subtitles, mix names, or the entire title.
  return normalizeText(title
    .replace(/[([]\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]/gi, " ")
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, " "));
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const na = versionTitle(a);
  const nb = versionTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

export function artistTokens(raw: string): Set<string> {
  const tokens = normalizeText(raw).split(/\s+/).filter(Boolean);
  const meaningful = tokens.filter((token) => !ARTIST_STOP_WORDS.has(token));
  return new Set(meaningful.length ? meaningful : tokens);
}

export function artistSimilarity(queryArtist: string, candidateArtists: string[] | string): number {
  const query = artistTokens(queryArtist);
  const candidate = artistTokens(
    Array.isArray(candidateArtists) ? candidateArtists.join(" ") : candidateArtists,
  );
  if (query.size === 0 || candidate.size === 0) return 0;
  let inter = 0;
  for (const token of query) if (candidate.has(token)) inter += 1;
  const union = new Set([...query, ...candidate]).size;
  return union === 0 ? 0 : inter / union;
}

export function artistOverlaps(queryArtist: string, candidateArtists: string[] | string): boolean {
  return artistSimilarity(queryArtist, candidateArtists) > 0;
}

const ALBUM_MATCH_THRESHOLD = 0.85;

const COMPILATION_RE =
  /\b(greatest hits|best of|the collection|the very best|the hits|hits collection|compilation|anthology|various artists|now that s what i call|singles(?: box| collection)?|ultimate collection)\b/;

export function normalizeAlbum(album: string): string {
  return normalizeTitle(album);
}

export function albumSimilarity(a: string, b: string): number {
  return titleSimilarity(a, b);
}

export function isCompilationAlbum(album: string | null | undefined): boolean {
  if (!album?.trim()) return false;
  return COMPILATION_RE.test(normalizeAlbum(album));
}

export interface FuzzyDecision {
  accepted: boolean;
  confidence: number;
  reason?: string;
}

type FuzzyTrack = Pick<TrackHit, "title" | "artists" | "duration_ms">;

export function evaluateFuzzy(
  source: FuzzyTrack,
  candidate: FuzzyTrack,
): FuzzyDecision {
  if (!durationWithinGate(source.duration_ms, candidate.duration_ms)) {
    return { accepted: false, confidence: 0, reason: "duration" };
  }
  if (versionKeywordsConflict(source.title, candidate.title)) {
    return { accepted: false, confidence: 0, reason: "version_keyword" };
  }
  const durDiff = Math.abs((source.duration_ms ?? 0) - (candidate.duration_ms ?? 0));
  const sim = titleSimilarity(source.title, candidate.title);
  if (sim < TITLE_MATCH_THRESHOLD) {
    return { accepted: false, confidence: 0, reason: "title" };
  }
  // Compare primary credits independently so a shared guest or one common
  // token cannot rescue a different performer. Missing credits fail closed.
  if (artistSimilarity(source.artists[0] ?? "", candidate.artists[0] ?? "") < ARTIST_MATCH_THRESHOLD) {
    return { accepted: false, confidence: 0, reason: "artist" };
  }
  const confidence = Math.min(0.8, 0.5 + 0.2 * (1 - durDiff / DURATION_GATE_MS) + 0.15 * sim);
  return { accepted: true, confidence };
}

export function pickFuzzyMatch(
  source: FuzzyTrack & { album?: string | null },
  candidates: TrackHit[],
): { hit: TrackHit; confidence: number } | null {
  const queryAlbum = source.album?.trim() ?? "";
  const queryLooksCompilation = isCompilationAlbum(queryAlbum);

  const accepted: Array<{
    hit: TrackHit;
    confidence: number;
    albumSim: number;
    compilation: boolean;
  }> = [];
  for (const hit of candidates) {
    const decision = evaluateFuzzy(source, hit);
    if (!decision.accepted) continue;
    accepted.push({
      hit,
      confidence: decision.confidence,
      albumSim: queryAlbum && hit.album ? albumSimilarity(queryAlbum, hit.album) : 0,
      compilation: isCompilationAlbum(hit.album),
    });
  }
  if (accepted.length === 0) return null;

  let pool = accepted;
  if (queryAlbum) {
    const albumMatches = accepted.filter((item) => item.albumSim >= ALBUM_MATCH_THRESHOLD);
    if (albumMatches.length > 0) {
      pool = albumMatches;
    } else if (!queryLooksCompilation) {
      const nonCompilations = accepted.filter((item) => !item.compilation);
      if (nonCompilations.length > 0) pool = nonCompilations;
    }
  }

  let best = pool[0];
  for (const item of pool) {
    if (item.albumSim > best.albumSim) {
      best = item;
    } else if (item.albumSim === best.albumSim && item.confidence > best.confidence) {
      best = item;
    }
  }
  return { hit: best.hit, confidence: best.confidence };
}
