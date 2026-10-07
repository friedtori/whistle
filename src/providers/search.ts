import type { SearchQuery, TrackHit } from "../types.ts";

export function escapeLucene(value: string): string {
  return value.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1");
}

export function quoteSearchValue(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function plainSearchQuery(query: SearchQuery, escape: (value: string) => string = (v) => v): string {
  return `${escape(query.artists[0] ?? "")} ${escape(query.title)}`.trim();
}

export async function searchWithPlainFallback(
  query: SearchQuery,
  strictQuery: string,
  fetchHits: (q: string) => Promise<TrackHit[]>,
  options: {
    escapePlain?: (value: string) => string;
    formatPlain?: (plain: string) => string;
  } = {},
): Promise<TrackHit[]> {
  const queries = [strictQuery];
  let plain = plainSearchQuery(query, options.escapePlain);
  if (plain && options.formatPlain) plain = options.formatPlain(plain);
  if (plain && plain !== strictQuery) queries.push(plain);

  const accepted = query.acceptHits ?? ((hits: TrackHit[]) => hits.length > 0);
  let last: TrackHit[] = [];
  for (const q of queries) {
    const hits = await fetchHits(q);
    last = hits;
    if (accepted(hits)) return hits;
  }
  return last;
}
