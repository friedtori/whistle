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
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
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

export function artistTokens(raw: string): Set<string> {
  return new Set(
    raw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token && !ARTIST_STOP_WORDS.has(token)),
  );
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

export interface FuzzyDecision {
  accepted: boolean;
  confidence: number;
  reason?: string;
}

export function evaluateFuzzy(
  source: { title: string; duration_ms: number | null },
  candidate: Pick<TrackHit, "title" | "duration_ms">,
): FuzzyDecision {
  if (!durationWithinGate(source.duration_ms, candidate.duration_ms)) {
    return { accepted: false, confidence: 0, reason: "duration" };
  }
  if (versionKeywordsConflict(source.title, candidate.title)) {
    return { accepted: false, confidence: 0, reason: "version_keyword" };
  }
  const durDiff = Math.abs((source.duration_ms ?? 0) - (candidate.duration_ms ?? 0));
  const sim = titleSimilarity(source.title, candidate.title);
  const confidence = Math.min(0.8, 0.5 + 0.2 * (1 - durDiff / DURATION_GATE_MS) + 0.15 * sim);
  return { accepted: true, confidence };
}

export function pickFuzzyMatch(
  source: { title: string; duration_ms: number | null },
  candidates: TrackHit[],
): { hit: TrackHit; confidence: number } | null {
  let best: { hit: TrackHit; confidence: number } | null = null;
  for (const hit of candidates) {
    const decision = evaluateFuzzy(source, hit);
    if (!decision.accepted) continue;
    if (!best || decision.confidence > best.confidence) {
      best = { hit, confidence: decision.confidence };
    }
  }
  return best;
}
