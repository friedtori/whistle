import type { SearchQuery, TrackHit } from "../types.ts";

export function plainSearchQuery(query: SearchQuery): string {
  return `${query.artists[0] ?? ""} ${query.title}`.trim();
}

export async function searchWithPlainFallback(
  query: SearchQuery,
  strictQuery: string,
  fetchHits: (q: string) => Promise<TrackHit[]>,
): Promise<TrackHit[]> {
  const queries = [strictQuery];
  const plain = plainSearchQuery(query);
  if (plain && plain !== strictQuery) queries.push(plain);
  for (const q of queries) {
    const hits = await fetchHits(q);
    if (hits.length > 0) return hits;
  }
  return [];
}
