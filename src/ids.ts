import { customAlphabet } from "nanoid";
import type { IdentifierKind, ParsedInput, Platform } from "./types.ts";

export const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

const PLATFORM_ALIASES: Record<string, IdentifierKind> = {
  isrc: "isrc",
  spotify: "spotify",
  apple: "apple",
  apple_music: "apple",
  "apple-music": "apple",
  itunes: "apple",
  deezer: "deezer",
  tidal: "tidal",
  ytm: "ytm",
  youtube: "ytm",
  youtube_music: "ytm",
  "youtube-music": "ytm",
  youtubemusic: "ytm",
  musicbrainz: "musicbrainz",
  mb: "musicbrainz",
  mbid: "musicbrainz",
};

export function normalizeIsrc(raw: string): string | null {
  const value = raw.toUpperCase().replace(/[-\s]/g, "");
  return ISRC_RE.test(value) ? value : null;
}

export function normalizePlatform(raw: string): IdentifierKind | null {
  return PLATFORM_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function canonicalUrl(kind: IdentifierKind, value: string): string {
  switch (kind) {
    case "spotify":
      return `https://open.spotify.com/track/${value}`;
    case "apple":
      return `https://music.apple.com/us/song/${value}`;
    case "deezer":
      return `https://www.deezer.com/track/${value}`;
    case "tidal":
      return `https://tidal.com/browse/track/${value}`;
    case "ytm":
      return `https://music.youtube.com/watch?v=${value}`;
    case "musicbrainz":
      return `https://musicbrainz.org/recording/${value}`;
    case "isrc":
      return `https://isrc.soundexchange.com/?isrc=${value}`;
  }
}

export function parseInput(input: {
  isrc?: string;
  platform?: string;
  id?: string;
  url?: string;
}): ParsedInput {
  if (input.isrc) {
    const isrc = normalizeIsrc(input.isrc);
    if (!isrc) throw badRequest(`Invalid ISRC: ${input.isrc}`);
    return { kind: "isrc", value: isrc };
  }

  if (input.url) {
    const parsed = parseUrl(input.url);
    if (!parsed) throw badRequest(`Unsupported URL: ${input.url}`);
    return parsed;
  }

  if (input.platform && input.id) {
    const kind = normalizePlatform(input.platform);
    if (!kind) throw badRequest(`Unsupported platform: ${input.platform}`);
    const value = input.id.trim();
    if (!value) throw badRequest("id is required");
    if (kind === "isrc") {
      const isrc = normalizeIsrc(value);
      if (!isrc) throw badRequest(`Invalid ISRC: ${value}`);
      return { kind: "isrc", value: isrc };
    }
    return { kind, value, url: canonicalUrl(kind, value) };
  }

  throw badRequest("Provide isrc, url, or platform+id");
}

export function parseUrl(raw: string): ParsedInput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const spotifyUri = /^spotify:track:([A-Za-z0-9]+)$/i.exec(trimmed);
  if (spotifyUri) {
    return {
      kind: "spotify",
      value: spotifyUri[1],
      url: canonicalUrl("spotify", spotifyUri[1]),
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
  } catch {
    const isrc = normalizeIsrc(trimmed);
    return isrc ? { kind: "isrc", value: isrc } : null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "open.spotify.com" || host === "spotify.link") {
    const trackIdx = parts.findIndex((p) => p === "track");
    const id = trackIdx >= 0 ? parts[trackIdx + 1] : null;
    if (id) return { kind: "spotify", value: id, url: canonicalUrl("spotify", id) };
  }

  if (host === "music.apple.com" || host === "itunes.apple.com") {
    const iParam = url.searchParams.get("i");
    const lastNumeric = [...parts].reverse().find((part) => /^\d+$/.test(part));
    const id = iParam ?? lastNumeric;
    if (id && /^\d+$/.test(id)) {
      return { kind: "apple", value: id, url: canonicalUrl("apple", id) };
    }
  }

  if (host === "deezer.com" || host.endsWith(".deezer.com") || host === "dzr.page.link") {
    const trackIdx = parts.findIndex((p) => p === "track");
    const id = trackIdx >= 0 ? parts[trackIdx + 1] : null;
    if (id && /^\d+$/.test(id)) {
      return { kind: "deezer", value: id, url: canonicalUrl("deezer", id) };
    }
  }

  if (host === "tidal.com" || host === "listen.tidal.com" || host.endsWith(".tidal.com")) {
    const trackIdx = parts.findIndex((p) => p === "track");
    const id = trackIdx >= 0 ? parts[trackIdx + 1] : null;
    if (id && /^\d+$/.test(id)) {
      return { kind: "tidal", value: id, url: canonicalUrl("tidal", id) };
    }
  }

  if (
    host === "music.youtube.com" ||
    host === "youtube.com" ||
    host === "youtu.be" ||
    host === "m.youtube.com"
  ) {
    const id = host === "youtu.be" ? parts[0] : url.searchParams.get("v");
    if (id) return { kind: "ytm", value: id, url: canonicalUrl("ytm", id) };
  }

  if (host === "musicbrainz.org") {
    const recIdx = parts.findIndex((p) => p === "recording");
    const id = recIdx >= 0 ? parts[recIdx + 1] : null;
    if (id) {
      return { kind: "musicbrainz", value: id, url: canonicalUrl("musicbrainz", id) };
    }
  }

  return null;
}

export function parsePlatformFromUrl(raw: string): { platform: Platform; id: string; url: string } | null {
  const parsed = parseUrl(raw);
  if (!parsed || parsed.kind === "isrc") return null;
  return {
    platform: parsed.kind,
    id: parsed.value,
    url: parsed.url ?? canonicalUrl(parsed.kind, parsed.value),
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}
