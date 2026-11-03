export interface Config {
  musicbrainzUserAgent: string;
  appleMusicToken?: string;
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
  appleStorefront: string;
  tidalClientId?: string;
  tidalClientSecret?: string;
  tidalCountry: string;
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  youtubeApiKey?: string;
  /** Workers subrequest limit per invocation (1000 paid, 50 free). */
  subrequestLimit: number;
  /** Max provider calls (fetch + MusicBrainz gate) one resolve may spend. */
  resolveSubrequestCap: number;
  /** Max inputs accepted by POST /v1/resolve/batch. */
  batchMaxInputs: number;
  /** Minimum spacing between MusicBrainz requests, enforced globally by the gate. */
  musicbrainzMinIntervalMs: number;
  gitCommit?: string;
}

export const DEFAULT_SUBREQUEST_LIMIT = 1000;
export const DEFAULT_RESOLVE_SUBREQUEST_CAP = 40;
export const DEFAULT_BATCH_MAX_INPUTS = 20;
export const DEFAULT_MUSICBRAINZ_MIN_INTERVAL_MS = 1100;

/** A string-valued binding map: Worker `env`, or `process.env` in Node scripts. */
export type ConfigSource = Record<string, unknown>;

function str(env: ConfigSource, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function int(env: ConfigSource, key: string, fallback: number, min = 1): number {
  const raw = str(env, key);
  const value = raw == null ? NaN : Number(raw);
  return Number.isInteger(value) && value >= min ? value : fallback;
}

export function loadConfig(env: ConfigSource): Config {
  return {
    musicbrainzUserAgent:
      str(env, "MUSICBRAINZ_USER_AGENT") ?? "Whistle/1.0 ( https://github.com/friedtori/whistle )",
    appleMusicToken: str(env, "APPLE_MUSIC_TOKEN"),
    appleTeamId: str(env, "APPLE_TEAM_ID"),
    appleKeyId: str(env, "APPLE_KEY_ID"),
    applePrivateKey: str(env, "APPLE_PRIVATE_KEY"),
    appleStorefront: str(env, "APPLE_STOREFRONT") ?? "us",
    tidalClientId: str(env, "TIDAL_CLIENT_ID"),
    tidalClientSecret: str(env, "TIDAL_CLIENT_SECRET"),
    tidalCountry: str(env, "TIDAL_COUNTRY") ?? "US",
    spotifyClientId: str(env, "SPOTIFY_CLIENT_ID"),
    spotifyClientSecret: str(env, "SPOTIFY_CLIENT_SECRET"),
    youtubeApiKey: str(env, "YOUTUBE_API_KEY"),
    subrequestLimit: int(env, "SUBREQUEST_LIMIT", DEFAULT_SUBREQUEST_LIMIT),
    resolveSubrequestCap: int(env, "RESOLVE_SUBREQUEST_CAP", DEFAULT_RESOLVE_SUBREQUEST_CAP),
    batchMaxInputs: Math.min(100, int(env, "BATCH_MAX_INPUTS", DEFAULT_BATCH_MAX_INPUTS)),
    musicbrainzMinIntervalMs: int(
      env,
      "MUSICBRAINZ_MIN_INTERVAL_MS",
      DEFAULT_MUSICBRAINZ_MIN_INTERVAL_MS,
      0,
    ),
    gitCommit: str(env, "WHISTLE_GIT_COMMIT") ?? str(env, "GIT_COMMIT"),
  };
}

export function hasAppleCatalogAuth(config: Config): boolean {
  if (config.appleMusicToken) return true;
  return Boolean(config.appleTeamId && config.appleKeyId && config.applePrivateKey);
}

export function hasTidalAuth(config: Config): boolean {
  return Boolean(config.tidalClientId && config.tidalClientSecret);
}

export function hasSpotifyAuth(config: Config): boolean {
  return Boolean(config.spotifyClientId && config.spotifyClientSecret);
}
