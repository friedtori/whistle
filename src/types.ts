export const PLATFORMS = [
  "apple",
  "deezer",
  "tidal",
  "musicbrainz",
  "spotify",
  "ytm",
] as const;

export type Platform = (typeof PLATFORMS)[number];

export const IDENTIFIER_KINDS = [
  "isrc",
  "spotify",
  "apple",
  "deezer",
  "tidal",
  "ytm",
  "musicbrainz",
  "query",
] as const;

export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

export const MATCH_METHODS = ["isrc", "mb_relation", "fuzzy", "user"] as const;
export type MatchMethod = (typeof MATCH_METHODS)[number];

export interface Recording {
  id: string;
  title: string;
  artists: string[];
  duration_ms: number | null;
  mbid: string | null;
}

export interface Identifier {
  recording_id: string;
  kind: IdentifierKind;
  value: string;
}

export interface PlatformLink {
  id: string;
  recording_id: string;
  platform: Platform;
  url: string | null;
  duration_ms: number | null;
  confidence: number;
  method: MatchMethod | null;
  verified_at: string;
  unmatched: boolean;
  skip_reason?: string | null;
}

export interface Correction {
  id: string;
  link_id: string | null;
  recording_id: string | null;
  platform: Platform | null;
  reason: "wrong" | "missing";
  submitted_at: string;
  status: "pending" | "accepted" | "rejected";
}

export interface ParsedInput {
  kind: IdentifierKind;
  value: string;
  url?: string;
  artist?: string;
  title?: string;
  album?: string;
  duration_ms?: number;
}

export interface ResolveQuery {
  isrc?: string;
  platform?: string;
  id?: string;
  url?: string;
  artist?: string;
  title?: string;
  album?: string;
  duration_ms?: number | string;
  duration?: number | string;
}

export interface TrackHit {
  platform: Platform;
  id: string;
  url: string;
  title: string;
  artists: string[];
  duration_ms: number | null;
  album?: string | null;
  isrc?: string | null;
  isrcs?: string[];
  mbid?: string | null;
}

export interface UrlRelation {
  platform: Platform;
  id: string;
  url: string;
}

export interface SearchQuery {
  title: string;
  artists: string[];
  duration_ms?: number | null;
}

export interface Provider {
  platform: Platform;
  enabled: boolean;
  supportsIsrcLookup: boolean;
  getById(id: string): Promise<TrackHit | null>;
  getByIsrc(isrc: string): Promise<TrackHit | null>;
  search(query: SearchQuery): Promise<TrackHit[]>;
}

export interface MusicBrainzProvider extends Provider {
  getByUrl(url: string): Promise<TrackHit | null>;
  getUrlRelations(mbid: string): Promise<{ relations: UrlRelation[]; isrcs: string[] }>;
}

export type ProviderMap = {
  apple: Provider;
  deezer: Provider;
  tidal: Provider;
  musicbrainz: MusicBrainzProvider;
  spotify: Provider;
  ytm: Provider;
};

export interface ResolveResponse {
  recording: Recording;
  identifiers: Array<{ kind: IdentifierKind; value: string }>;
  links: PlatformLink[];
  cached: boolean;
}
