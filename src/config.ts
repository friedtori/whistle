export interface Config {
  port: number;
  databasePath: string;
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
}

function emptyToUndef(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    databasePath: env.DATABASE_PATH ?? "./data/whistle.db",
    musicbrainzUserAgent:
      emptyToUndef(env.MUSICBRAINZ_USER_AGENT) ??
      "Whistle/1.0 ( https://github.com/friedtori/whistle )",
    appleMusicToken: emptyToUndef(env.APPLE_MUSIC_TOKEN),
    appleTeamId: emptyToUndef(env.APPLE_TEAM_ID),
    appleKeyId: emptyToUndef(env.APPLE_KEY_ID),
    applePrivateKey: emptyToUndef(env.APPLE_PRIVATE_KEY),
    appleStorefront: emptyToUndef(env.APPLE_STOREFRONT) ?? "us",
    tidalClientId: emptyToUndef(env.TIDAL_CLIENT_ID),
    tidalClientSecret: emptyToUndef(env.TIDAL_CLIENT_SECRET),
    tidalCountry: emptyToUndef(env.TIDAL_COUNTRY) ?? "US",
    spotifyClientId: emptyToUndef(env.SPOTIFY_CLIENT_ID),
    spotifyClientSecret: emptyToUndef(env.SPOTIFY_CLIENT_SECRET),
    youtubeApiKey: emptyToUndef(env.YOUTUBE_API_KEY),
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
