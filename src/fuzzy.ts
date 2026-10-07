import type { TrackHit } from "./types.ts";

const DURATION_GATE_MS = 2000;

const VERSION_FAMILIES: Array<{ family: string; pattern: RegExp }> = [
  { family: "live", pattern: /\blive\b/i },
  { family: "remix", pattern: /\b(?:re-?mix(?:ed)?|rmx)\b/i },
  { family: "edit", pattern: /\b(?:re-?edits?|edits?)\b/i },
  { family: "remaster", pattern: /\bre-?masters?(?:ed)?\b/i },
  { family: "acoustic", pattern: /\bacoustic\b/i },
  { family: "instrumental", pattern: /\binstrumental\b/i },
  { family: "karaoke", pattern: /\bkaraoke\b/i },
  { family: "cover", pattern: /\bcover\b/i },
  { family: "acapella", pattern: /\b(?:a\s*capp?ella|acapp?ella)\b/i },
];

export const TITLE_SIMILARITY_FLOOR = 0.5;

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
  return false;
}

export function durationWithinGate(
  sourceMs: number | null | undefined,
  candidateMs: number | null | undefined,
  gateMs = DURATION_GATE_MS,
): boolean {
  if (sourceMs == null || candidateMs == null) return false;
  return Math.abs(sourceMs - candidateMs) <= gateMs;
}

export function normalizeTitle(title: string): string {
  return title
    .normalize("NFC")
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Like normalizeTitle but keeps parenthetical words (for ranking fidelity). */
export function normalizeTitleKeepParens(title: string): string {
  return title
    .normalize("NFC")
    .toLowerCase()
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleFidelity(a: string, b: string): number {
  const na = normalizeTitleKeepParens(a);
  const nb = normalizeTitleKeepParens(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
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

/** Latin vs non-Latin pair (気分上々 vs Kibun Jou Jou). Do not reject on title sim alone. */
export function isTransliterationPair(a: string, b: string): boolean {
  const sa = letterScripts(a);
  const sb = letterScripts(b);
  const aNon = sa.other && !sa.latin;
  const bNon = sb.other && !sb.latin;
  const aLat = sa.latin && !sa.other;
  const bLat = sb.latin && !sb.other;
  return (aNon && bLat) || (bNon && aLat);
}

export function collapseTitle(title: string): string {
  return normalizeTitle(title).replace(/\s+/g, "");
}

export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (collapseTitle(a) === collapseTitle(b)) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : inter / union;
}

export function artistTokens(raw: string): Set<string> {
  return new Set(
    raw
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token && !ARTIST_STOP_WORDS.has(token)),
  );
}

function artistListText(artists?: string[] | string | null): string {
  if (artists == null) return "";
  return (Array.isArray(artists) ? artists.join(" ") : artists).trim();
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
  artists?: string[] | string | null;
};

export type FuzzyCandidate = Pick<TrackHit, "title" | "duration_ms"> & {
  album?: string | null;
  url?: string | null;
  artists?: string[] | string | null;
};

export function evaluateFuzzy(source: FuzzySource, candidate: FuzzyCandidate): FuzzyDecision {
  if (!durationWithinGate(source.duration_ms, candidate.duration_ms)) {
    return { accepted: false, confidence: 0, reason: "duration" };
  }
  if (versionKeywordsConflict(sourceVersionText(source), destinationVersionText(candidate))) {
    return { accepted: false, confidence: 0, reason: "version_keyword" };
  }
  const sourceArtists = artistListText(source.artists);
  const candidateArtists = artistListText(candidate.artists);
  if (sourceArtists && candidateArtists && !artistOverlaps(sourceArtists, candidateArtists)) {
    return { accepted: false, confidence: 0, reason: "artist" };
  }
  const sim = titleSimilarity(source.title, candidate.title);
  const crossScript = isTransliterationPair(source.title, candidate.title);
  if (sim < TITLE_SIMILARITY_FLOOR && !crossScript) {
    return { accepted: false, confidence: 0, reason: "title" };
  }
  const durDiff = Math.abs((source.duration_ms ?? 0) - (candidate.duration_ms ?? 0));
  const confidence = Math.min(0.8, 0.5 + 0.2 * (1 - durDiff / DURATION_GATE_MS) + 0.15 * sim);
  return { accepted: true, confidence };
}

/** Destination hops: reject contradictory metadata; missing fields are not contradictions. */
export function destinationMatchesRecording(
  recording: { title: string; artists: string[]; duration_ms: number | null },
  hit: Pick<TrackHit, "title" | "artists" | "duration_ms"> & {
    album?: string | null;
    url?: string | null;
  },
): boolean {
  const sim = titleSimilarity(recording.title, hit.title);
  const crossScript = isTransliterationPair(recording.title, hit.title);
  if (sim < TITLE_SIMILARITY_FLOOR && !crossScript) return false;
  if (versionKeywordsConflict(recording.title, destinationVersionText(hit))) return false;
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
