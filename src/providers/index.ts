import type { Config } from "../config.ts";
import type { ProviderMap } from "../types.ts";
import { createAppleProvider } from "./apple.ts";
import { createDeezerProvider } from "./deezer.ts";
import { createMusicBrainzProvider } from "./musicbrainz.ts";
import { createSpotifyProvider } from "./spotify.ts";
import { createTidalProvider } from "./tidal.ts";
import { createYtmProvider } from "./ytm.ts";

export function createProviders(config: Config): ProviderMap {
  return {
    apple: createAppleProvider(config),
    deezer: createDeezerProvider(),
    tidal: createTidalProvider(config),
    musicbrainz: createMusicBrainzProvider(config.musicbrainzUserAgent),
    spotify: createSpotifyProvider(config),
    ytm: createYtmProvider(config),
  };
}

export { createAppleProvider } from "./apple.ts";
export { createDeezerProvider } from "./deezer.ts";
export { createMusicBrainzProvider } from "./musicbrainz.ts";
export { createSpotifyProvider } from "./spotify.ts";
export { createTidalProvider } from "./tidal.ts";
export { createYtmProvider } from "./ytm.ts";
