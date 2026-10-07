# Whistle

Hosted, developer-first music track resolver. Give it an ISRC, a platform track ID, a link that encodes one, or a title + artist + duration. Get back a **Recording** plus **PlatformLinks** for Apple Music, Deezer, Tidal, MusicBrainz, Spotify, and YouTube Music — each with `confidence` (0–1) and `method` (`isrc` | `isrc_from_fuzzy` | `mb_relation` | `fuzzy` | `user`).

Whistle is an API for apps (Gum consumes it via deep links). It is not a paste-a-link marketing page.

## Run locally

```bash
npm install
cp .env.example .env   # optional; Deezer + MusicBrainz work with no keys
npm start              # http://127.0.0.1:3000
```

```bash
curl 'http://127.0.0.1:3000/v1/resolve?isrc=USUG11904206'
curl 'http://127.0.0.1:3000/v1/resolve?url=https://www.deezer.com/track/916424'
curl 'http://127.0.0.1:3000/v1/resolve?platform=spotify&id=0VjIjW4GlUZAMYd2vXMi3b'
curl 'http://127.0.0.1:3000/v1/resolve?artist=The%20Weeknd&title=Blinding%20Lights&duration_ms=200040'
curl 'http://127.0.0.1:3000/v1/resolve?artist=Alanis%20Morissette&title=Ironic&album=Jagged%20Little%20Pill&duration_ms=230000'
```

```bash
npm test               # mocked unit + API tests (no live keys)
WHISTLE_LIVE_TESTS=1 npm test   # also hit public Deezer + MusicBrainz
```

Requires Node 22+ (uses the built-in `node:sqlite` cache).

## Env vars

| Variable | Required | Notes |
| --- | --- | --- |
| `PORT` | no | Default `3000` |
| `DATABASE_PATH` | no | SQLite file; default `./data/whistle.db` |
| `MUSICBRAINZ_USER_AGENT` | no | Descriptive UA. Default: `Whistle/1.0 ( https://github.com/friedtori/whistle )` |
| `APPLE_MUSIC_TOKEN` | no | Pre-built MusicKit developer JWT |
| `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | no | Used to mint a JWT when `APPLE_MUSIC_TOKEN` is unset. `APPLE_PRIVATE_KEY` is the `.p8` PEM (`\n` escaped or a single-line PEM is fine) |
| `APPLE_STOREFRONT` | no | Default `us` |
| `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` | no | Tidal Open API v2 client-credentials. Skipped when unset |
| `TIDAL_COUNTRY` | no | Default `US` |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | no | Optional. Spotify is resolved **last** and never trusted alone |
| `YOUTUBE_API_KEY` | no | YouTube Data API v3; YouTube Music is fuzzy-only |
| `WHISTLE_LIVE_TESTS` | no | Set `1` to run live provider tests |

Missing credentials skip that platform; other platforms still resolve. When MusicKit catalog auth is configured, Apple lookups use the catalog API only (iTunes Search/Lookup is not used as a fallback, which avoids dead `/song/{id}` links). Without catalog auth, Apple falls back to the public iTunes Lookup/Search API. Deezer and MusicBrainz need no keys.

## API

All resolve responses include `recording`, `identifiers`, `links[]` (`confidence` + `method` on every platform, including unmatched), and `cached`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/resolve?isrc=` or `?platform=&id=` or `?url=` or `?artist=&title=&duration_ms=` (`album` optional) | Resolve one input |
| `POST` | `/v1/resolve/batch` | Up to 100 inputs: `{ "inputs": [ { "isrc" }, { "platform", "id" }, { "url" }, { "artist", "title", "duration_ms", "album"? } ] }` |
| `GET` | `/v1/recordings/{id}` | Cached recording + links |
| `POST` | `/v1/corrections` | Flag a link: `{ "link_id", "reason": "wrong" }` or `{ "recording_id", "platform", "reason": "missing" }` |
| `GET` | `/health` | Liveness |

v1 platforms: `apple`, `deezer`, `tidal`, `musicbrainz`, `spotify`, `ytm`.

### Pipeline

1. Cache (exact input identifier, including a normalized `query` key for artist+title+duration, plus album when sent)
2. ISRC lookups (Deezer, Apple, Tidal, MusicBrainz) — or, for artist+title, a Deezer/Apple/Tidal search bootstrap that must pass the fuzzy gates. Seed/input ISRCs use `method: isrc` / `0.98`; a direct platform+id match on its own platform stays `1`. ISRCs discovered via a fuzzy MusicBrainz match are tagged `isrc_from_fuzzy` at `0.8 × 0.98` and are not stored as ISRC identifiers
3. MusicBrainz sibling ISRCs on the same recording (same provenance as the MB match), then a second ISRC pass that skips already-tried `(platform, isrc)` pairs
4. MusicBrainz URL relations
5. Fuzzy title/artist search — requires positive durations within 2 seconds, title token similarity ≥0.8, and primary-artist token similarity ≥0.8. Unicode letters and combining marks are preserved with NFKC normalization. Version families (`live`, `remix`, `edit`, `remaster`, `acoustic`, `instrumental`, `karaoke`, `cover`, `demo`, `session`) must agree; version-bearing titles must also agree after punctuation and spelling-alias normalization, so different named mixes or live venues are rejected. Deezer/Spotify/MusicBrainz retry a plain `artist title` query when the strict fielded search returns no **accepted** hit (not only when it returns no rows). MusicBrainz plain queries escape Lucene operators; Deezer quotes the plain query so `:` is not a field separator
6. Spotify last (trusted ISRC, then `isrc_from_fuzzy`, then search). Never used as the sole authority for other platforms

Artist+title resolve is for listening-history rows that have no ISRC. **`duration_ms` is required** (or `duration` in seconds on GET). Bootstrap and all destination searches use the same fuzzy acceptance gates above. Optional `album` is a soft preference among accepted candidates: matching album titles win, and obvious compilations (`greatest hits`, `the collection`, …) are downranked unless they are the only match or the query album itself looks like a compilation. The bootstrap platform link is stored with `method: "fuzzy"`. If search finds no accepted hit, the API returns `404 not_found`.

Fuzzy matching is conservative: reordered or differently formatted joint artist credits may be rejected, and cross-script transliteration is not implemented. Thresholds are heuristics, not calibrated probabilities. Existing cached resolutions are not revalidated by these gates; the gates apply when running a new search.

Repeat lookups of the same input are served from the SQLite cache.

Rate limits are not enforced in this prototype; cache aggressively and keep MusicBrainz at ≤1 req/s via a built-in limiter. Review each provider ToS before commercial use.

## Entities

- **Recording**: `id`, `title`, `artists[]`, `duration_ms`, `mbid?`
- **Identifier**: `recording_id`, `kind` (`isrc` \| `spotify` \| `apple` \| `deezer` \| `tidal` \| `ytm` \| `musicbrainz` \| `query`), `value`
- **PlatformLink**: `id`, `recording_id`, `platform`, `url`, `duration_ms`, `confidence`, `method`, `verified_at`, `unmatched`
- **Correction**: `link_id?`, `recording_id?`, `reason` (`wrong` \| `missing`), `submitted_at`, `status`
