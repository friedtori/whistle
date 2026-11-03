import type { MusicBrainzGate } from "./musicbrainz-gate.ts";

/** Worker bindings. Secrets are optional: a missing credential skips that platform. */
export interface Env {
  DB: D1Database;
  MUSICBRAINZ_GATE: DurableObjectNamespace<MusicBrainzGate>;

  // vars (wrangler.jsonc)
  MUSICBRAINZ_USER_AGENT?: string;
  APPLE_STOREFRONT?: string;
  TIDAL_COUNTRY?: string;
  SUBREQUEST_LIMIT?: string;
  RESOLVE_SUBREQUEST_CAP?: string;
  BATCH_MAX_INPUTS?: string;
  MUSICBRAINZ_MIN_INTERVAL_MS?: string;
  WHISTLE_GIT_COMMIT?: string;
  ANON_RESOLVES_PER_HOUR?: string;
  VERIFIED_RESOLVES_PER_DAY?: string;
  GUM_LICENSE_PUBLIC_KEY?: string;

  // secrets (wrangler secret put)
  APPLE_MUSIC_TOKEN?: string;
  APPLE_PRIVATE_KEY?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  TIDAL_CLIENT_ID?: string;
  TIDAL_CLIENT_SECRET?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  YOUTUBE_API_KEY?: string;
  SESSION_SECRET?: string;
}
