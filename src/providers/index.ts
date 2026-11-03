import type { Config } from "../config.ts";
import { httpJson, type HttpJson } from "../http.ts";
import type { ProviderMap } from "../types.ts";
import { createAppleProvider } from "./apple.ts";
import { createDeezerProvider } from "./deezer.ts";
import { createLocalMbGate, createMusicBrainzProvider, type MbGate } from "./musicbrainz.ts";
import { createSpotifyProvider } from "./spotify.ts";
import { createTidalProvider } from "./tidal.ts";
import { createYtmProvider } from "./ytm.ts";

export interface ProviderTransport {
  /** Outbound JSON fetch (budgeted on Workers). */
  http?: HttpJson;
  /** MusicBrainz rate gate (Durable Object on Workers). */
  mbGate?: MbGate;
}

export function createProviders(config: Config, transport: ProviderTransport = {}): ProviderMap {
  const http = transport.http ?? httpJson;
  const mbGate =
    transport.mbGate ??
    createLocalMbGate(config.musicbrainzUserAgent, config.musicbrainzMinIntervalMs, http);
  return {
    apple: createAppleProvider(config, http),
    deezer: createDeezerProvider(http),
    tidal: createTidalProvider(config, http),
    musicbrainz: createMusicBrainzProvider(mbGate),
    spotify: createSpotifyProvider(config, http),
    ytm: createYtmProvider(config, http),
  };
}

export { createAppleProvider } from "./apple.ts";
export { createDeezerProvider } from "./deezer.ts";
export { createLocalMbGate, createMusicBrainzProvider } from "./musicbrainz.ts";
export { createSpotifyProvider } from "./spotify.ts";
export { createTidalProvider } from "./tidal.ts";
export { createYtmProvider } from "./ytm.ts";
