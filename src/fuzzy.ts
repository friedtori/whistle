import type { TrackHit } from "./types.ts";

const DURATION_GATE_MS = 2000;
/** Fuzzy acceptance (bootstrap + destination searches): title token similarity. */
export const TITLE_MATCH_THRESHOLD = 0.8;
/** Fuzzy acceptance: primary-artist token similarity. */
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
  { family: "acapella", pattern: /\b(?:a\s*capp?ella|acapp?ella)\b/i },
];

/**
 * Contradiction floor for destination hops whose identity comes from an ISRC,
 * an MBID, or a MusicBrainz URL relation (and for recording reuse). This is
 * deliberately looser than the fuzzy acceptance threshold: it only rejects
 * hops whose metadata contradicts the chosen recording.
 */
export const TITLE_SIMILARITY_FLOOR = 0.5;

const ARTIST_STOP_WORDS = new Set(["the", "a", "an", "and", "of", "feat", "ft", "featuring"]);

export function versionFamilies(title: string): Set<string> {
  const found = new Set<string>();
  for (const { family, pattern } of VERSION_FAMILIES) {
    if (pattern.test(title)) found.add(family);
  }
  return found;
}

/** Version families must agree. `text` may include album and URL-slug words. */
export function versionFamiliesConflict(sourceText: string, candidateText: string): boolean {
  const a = versionFamilies(sourceText);
  const b = versionFamilies(candidateText);
  if (a.size !== b.size) return true;
  for (const family of a) {
    if (!b.has(family)) return true;
  }
  return false;
}

/**
 * Fuzzy-acceptance version check. Families are compared over the optional
 * context text (title + album + URL slug); when either *title* carries a
 * version family, the version-bearing titles must also agree after
 * punctuation and spelling-alias normalization, because family equality is
 * insufficient: two named remixes or live venues may be different recordings.
 */
export function versionKeywordsConflict(
  sourceTitle: string,
  candidateTitle: string,
  context: { source?: string; candidate?: string } = {},
): boolean {
  if (versionFamiliesConflict(context.source ?? sourceTitle, context.candidate ?? candidateTitle)) {
    return true;
  }
  const titleFamilies = versionFamilies(sourceTitle).size + versionFamilies(candidateTitle).size;
  if (titleFamilies > 0 && versionTitle(sourceTitle) !== versionTitle(candidateTitle)) return true;
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

/**
 * Strip only explicit featured-artist credits; parentheses can contain
 * meaningful subtitles, mix names, or the entire title.
 */
export function normalizeTitle(title: string): string {
  return normalizeText(title
    .replace(/[([]\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]*[)\]]/gi, " ")
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, " "));
}

/** Title with every parenthetical/bracketed segment removed (contradiction checks only). */
export function coreTitle(title: string): string {
  return normalizeTitle(title.replace(/\([^)]*\)|\[[^\]]*\]/g, " "));
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(na: string, nb: string): number {
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

/** Ranking among already-accepted candidates only; never an acceptance gate. */
export function titleFidelity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  return jaccard(na, nb);
}

export function urlSlugWords(url?: string | null): string {
  if (!url) return "";
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // keep raw
  }
  return path
    .split("/")
    .filter((part) => part && !/^\d+$/.test(part) && !/^[a-z]{2}$/i.test(part))
    .join(" ")
    .replace(/[-_+]+/g, " ");
}

export function destinationVersionText(hit: {
  title: string;
  album?: string | null;
  url?: string | null;
}): string {
  return [hit.title, hit.album ?? "", urlSlugWords(hit.url)].filter(Boolean).join(" ");
}

export function sourceVersionText(source: { title: string; album?: string | null }): string {
  return [source.title, source.album ?? ""].filter(Boolean).join(" ");
}

function letterScripts(title: string): { latin: boolean; other: boolean } {
  let latin = false;
  let other = false;
  for (const ch of normalizeTitle(title)) {
    if (/\p{N}/u.test(ch) || /\s/.test(ch)) continue;
    if (/\p{Script=Latin}/u.test(ch)) latin = true;
    else if (/\p{L}/u.test(ch)) other = true;
  }
  return { latin, other };
}

/** Title floor applies when both sides have Latin tokens or both are non-Latin. */
export function titlesShareComparableScript(a: string, b: string): boolean {
  const sa = letterScripts(a);
  const sb = letterScripts(b);
  if (sa.latin && sb.latin) return true;
  if (sa.other && sb.other && !sa.latin && !sb.latin) return true;
  return false;
}

/**
 * Latin vs non-Latin pair (気分上々 vs Kibun Jou Jou). Used only by the
 * destination contradiction check for identifier-backed hops; fuzzy
 * acceptance does not implement transliteration and rejects these.
 */
export function isTransliterationPair(a: string, b: string): boolean {
  const sa = letterScripts(a);
  const sb = letterScripts(b);
  const aNon = sa.other && !sa.latin;
  const bNon = sb.other && !sb.latin;
  const aLat = sa.latin && !sa.other;
  const bLat = sb.latin && !sb.other;
  return (aNon && bLat) || (bNon && aLat);
}

/** `HandsOn` and `Hands On` collapse to the same string. */
export function collapseTitle(title: string): string {
  return versionTitle(title).replace(/\s+/g, "");
}

/** Fuzzy-acceptance title similarity: token Jaccard on version-normalized titles. */
export function titleSimilarity(a: string, b: string): number {
  const na = versionTitle(a);
  const nb = versionTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.replace(/\s+/g, "") === nb.replace(/\s+/g, "")) return 1;
  return jaccard(na, nb);
}

/** Contradiction-check title similarity: ignores parenthetical subtitles. */
export function coreTitleSimilarity(a: string, b: string): number {
  const na = coreTitle(a);
  const nb = coreTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.replace(/\s+/g, "") === nb.replace(/\s+/g, "")) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  return jaccard(na, nb);
}

export function artistTokens(raw: string): Set<string> {
  const tokens = normalizeText(raw).split(/\s+/).filter(Boolean);
  const meaningful = tokens.filter((token) => !ARTIST_STOP_WORDS.has(token));
  return new Set(meaningful.length ? meaningful : tokens);
}

function primaryArtist(artists?: string[] | string | null): string {
  if (artists == null) return "";
  return (Array.isArray(artists) ? (artists[0] ?? "") : artists).trim();
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

export type FuzzySource = {
  title: string;
  duration_ms: number | null;
  album?: string | null;
  artists: string[] | string;
};

export type FuzzyCandidate = Pick<TrackHit, "title" | "duration_ms" | "artists"> & {
  album?: string | null;
  url?: string | null;
};

export function evaluateFuzzy(source: FuzzySource, candidate: FuzzyCandidate): FuzzyDecision {
  if (!durationWithinGate(source.duration_ms, candidate.duration_ms)) {
    return { accepted: false, confidence: 0, reason: "duration" };
  }
  if (
    versionKeywordsConflict(source.title, candidate.title, {
      source: sourceVersionText(source),
      candidate: destinationVersionText(candidate),
    })
  ) {
    return { accepted: false, confidence: 0, reason: "version_keyword" };
  }
  const sim = titleSimilarity(source.title, candidate.title);
  if (sim < TITLE_MATCH_THRESHOLD) {
    return { accepted: false, confidence: 0, reason: "title" };
  }
  // Compare primary credits independently so a shared guest or one common
  // token cannot rescue a different performer. Missing credits fail closed.
  if (artistSimilarity(primaryArtist(source.artists), primaryArtist(candidate.artists)) < ARTIST_MATCH_THRESHOLD) {
    return { accepted: false, confidence: 0, reason: "artist" };
  }
  const durDiff = Math.abs((source.duration_ms ?? 0) - (candidate.duration_ms ?? 0));
  const confidence = Math.min(0.8, 0.5 + 0.2 * (1 - durDiff / DURATION_GATE_MS) + 0.15 * sim);
  return { accepted: true, confidence };
}

/**
 * Destination hops: reject contradictory metadata; missing fields are not
 * contradictions. Applied to every hop (ISRC, MB relation, fuzzy) and to
 * recording reuse. Fuzzy hops have already passed `evaluateFuzzy`.
 */
export function destinationMatchesRecording(
  recording: { title: string; artists: string[]; duration_ms: number | null },
  hit: Pick<TrackHit, "title" | "artists" | "duration_ms"> & {
    album?: string | null;
    url?: string | null;
  },
): boolean {
  const sim = coreTitleSimilarity(recording.title, hit.title);
  const crossScript = isTransliterationPair(recording.title, hit.title);
  if (sim < TITLE_SIMILARITY_FLOOR && !crossScript) return false;
  if (versionFamiliesConflict(recording.title, destinationVersionText(hit))) return false;
  if (
    recording.duration_ms != null &&
    hit.duration_ms != null &&
    !durationWithinGate(recording.duration_ms, hit.duration_ms)
  ) {
    return false;
  }
  if (
    recording.artists.length > 0 &&
    hit.artists.length > 0 &&
    !artistOverlaps(recording.artists.join(" "), hit.artists)
  ) {
    return false;
  }
  return true;
}

export function pickFuzzyMatch(
  source: FuzzySource,
  candidates: TrackHit[],
): { hit: TrackHit; confidence: number } | null {
  const queryAlbum = source.album?.trim() ?? "";
  const queryLooksCompilation = isCompilationAlbum(queryAlbum);

  const accepted: Array<{
    hit: TrackHit;
    confidence: number;
    albumSim: number;
    compilation: boolean;
    titleFidelity: number;
  }> = [];
  for (const hit of candidates) {
    const decision = evaluateFuzzy(source, hit);
    if (!decision.accepted) continue;
    accepted.push({
      hit,
      confidence: decision.confidence,
      albumSim: queryAlbum && hit.album ? albumSimilarity(queryAlbum, hit.album) : 0,
      compilation: isCompilationAlbum(hit.album),
      titleFidelity: titleFidelity(source.title, hit.title),
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
    } else if (item.albumSim === best.albumSim && item.titleFidelity > best.titleFidelity) {
      best = item;
    } else if (
      item.albumSim === best.albumSim &&
      item.titleFidelity === best.titleFidelity &&
      item.confidence > best.confidence
    ) {
      best = item;
    }
  }
  return { hit: best.hit, confidence: best.confidence };
}
