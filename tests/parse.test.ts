import { describe, expect, it } from "vitest";
import { normalizeIsrc, parseInput, parseUrl, queryCacheKey } from "../src/ids.ts";

describe("parseUrl / parseInput", () => {
  it("parses ISRC with or without dashes", () => {
    expect(normalizeIsrc("usug11904206")).toBe("USUG11904206");
    expect(normalizeIsrc("US-UG1-19-04206")).toBe("USUG11904206");
    expect(parseInput({ isrc: "USUG11904206" })).toEqual({ kind: "isrc", value: "USUG11904206" });
  });

  it("parses Spotify track URLs and URIs", () => {
    expect(parseUrl("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b?si=abc")).toMatchObject({
      kind: "spotify",
      value: "0VjIjW4GlUZAMYd2vXMi3b",
    });
    expect(parseUrl("spotify:track:0VjIjW4GlUZAMYd2vXMi3b")).toMatchObject({
      kind: "spotify",
      value: "0VjIjW4GlUZAMYd2vXMi3b",
    });
  });

  it("parses Apple Music song URLs and album ?i= links", () => {
    expect(parseUrl("https://music.apple.com/us/song/blinding-lights/1493988146")).toMatchObject({
      kind: "apple",
      value: "1493988146",
    });
    expect(
      parseUrl("https://music.apple.com/us/album/blinding-lights/1493988108?i=1493988146"),
    ).toMatchObject({ kind: "apple", value: "1493988146" });
  });

  it("parses Deezer, Tidal, YouTube Music, and MusicBrainz URLs", () => {
    expect(parseUrl("https://www.deezer.com/track/916424")).toMatchObject({
      kind: "deezer",
      value: "916424",
    });
    expect(parseUrl("https://tidal.com/browse/track/126173746")).toMatchObject({
      kind: "tidal",
      value: "126173746",
    });
    expect(parseUrl("https://listen.tidal.com/track/126173746")).toMatchObject({
      kind: "tidal",
      value: "126173746",
    });
    expect(parseUrl("https://music.youtube.com/watch?v=4NRXx6U63PY")).toMatchObject({
      kind: "ytm",
      value: "4NRXx6U63PY",
    });
    expect(parseUrl("https://youtu.be/4NRXx6U63PY")).toMatchObject({
      kind: "ytm",
      value: "4NRXx6U63PY",
    });
    expect(
      parseUrl("https://musicbrainz.org/recording/0af65fc4-5ef7-4c0e-8f6b-0c1e6c0d8e11"),
    ).toMatchObject({
      kind: "musicbrainz",
      value: "0af65fc4-5ef7-4c0e-8f6b-0c1e6c0d8e11",
    });
  });

  it("accepts platform+id aliases", () => {
    expect(parseInput({ platform: "apple_music", id: "1493988146" })).toMatchObject({
      kind: "apple",
      value: "1493988146",
    });
    expect(parseInput({ platform: "youtube", id: "4NRXx6U63PY" })).toMatchObject({
      kind: "ytm",
      value: "4NRXx6U63PY",
    });
  });

  it("rejects empty and unknown inputs", () => {
    expect(() => parseInput({})).toThrow(/isrc, url, platform\+id, or artist\+title/);
    expect(() => parseInput({ platform: "qobuz", id: "1" })).toThrow(/Unsupported platform/);
    expect(() => parseInput({ isrc: "not-an-isrc" })).toThrow(/Invalid ISRC/);
  });

  it("parses artist+title with duration_ms into a stable query key", () => {
    expect(
      parseInput({ artist: "The Weeknd", title: "Blinding Lights", duration_ms: 200_040 }),
    ).toEqual({
      kind: "query",
      value: queryCacheKey("The Weeknd", "Blinding Lights", 200_040),
      artist: "The Weeknd",
      title: "Blinding Lights",
      duration_ms: 200_040,
    });
    expect(queryCacheKey("The  Weeknd", "Blinding Lights", 200_040)).toBe(
      queryCacheKey("the weeknd", "blinding lights", 200_040),
    );
  });

  it("accepts duration in seconds and requires duration for artist+title", () => {
    expect(parseInput({ artist: "The Weeknd", title: "Blinding Lights", duration: 200.04 })).toMatchObject({
      kind: "query",
      duration_ms: 200_040,
    });
    expect(() => parseInput({ artist: "The Weeknd", title: "Blinding Lights" })).toThrow(
      /duration_ms is required/,
    );
  });
});
