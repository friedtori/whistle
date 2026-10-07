# Whistle

Hosted, developer-first music track resolver. Give it an ISRC, a platform track ID, a link that encodes one, or a title + artist + duration. Get back a **Recording** plus **PlatformLinks** for Apple Music, Deezer, Tidal, MusicBrainz, Spotify, and YouTube Music — each with `confidence` (0–1) and `method` (`isrc` | `mb_relation` | `fuzzy` | `user`).

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
| `APPLE_TEAM_ID` / `APPLE_KEY_ID` / `APPLE_PRIVATE_KEY` | no | Used to mint a JWT when `APPLE_MUSIC_TOKEN` is unset. `APPLE_PRIVATE_KEY` is the `.p8` PEM (`\n` escaped is fine) |
| `APPLE_STOREFRONT` | no | Default `us` |
| `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` | no | Tidal Open API v2 client-credentials. Skipped when unset |
| `TIDAL_COUNTRY` | no | Default `US` |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | no | Optional. Spotify is resolved **last** and never trusted alone |
| `YOUTUBE_API_KEY` | no | YouTube Data API v3; YouTube Music is fuzzy-only |
| `WHISTLE_LIVE_TESTS` | no | Set `1` to run live provider tests |

Missing credentials skip that platform; other platforms still resolve. Apple song IDs and title search fall back to the public iTunes Lookup/Search API when no MusicKit token is configured. Deezer and MusicBrainz need no keys.

## API

All resolve responses include `recording`, `identifiers`, `links[]` (`confidence` + `method` on every platform, including unmatched), and `cached`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/resolve?isrc=` or `?platform=&id=` or `?url=` or `?artist=&title=&duration_ms=` | Resolve one input |
| `POST` | `/v1/resolve/batch` | Up to 100 inputs: `{ "inputs": [ { "isrc" }, { "platform", "id" }, { "url" }, { "artist", "title", "duration_ms" } ] }` |
| `GET` | `/v1/recordings/{id}` | Cached recording + links |
| `POST` | `/v1/corrections` | Flag a link: `{ "link_id", "reason": "wrong" }` or `{ "recording_id", "platform", "reason": "missing" }` |
| `GET` | `/health` | Liveness |

v1 platforms: `apple`, `deezer`, `tidal`, `musicbrainz`, `spotify`, `ytm`.

### Pipeline

1. Cache (exact input identifier, including a normalized `query` key for artist+title+duration)
2. ISRC lookups (Deezer, Apple, Tidal, MusicBrainz) — or, for artist+title, a Deezer/Apple/Tidal search bootstrap that must pass the fuzzy gates
3. MusicBrainz URL relations
4. Fuzzy title/artist search — accepted only when duration is within 2 seconds **and** version keywords (`live`, `remix`, `edit`, `remaster`, plus `acoustic` / `instrumental` / `karaoke` / `cover`) do not conflict
5. Spotify last (ISRC, then search). Never used as the sole authority for other platforms

Artist+title resolve is for listening-history rows that have no ISRC. **`duration_ms` is required** (or `duration` in seconds on GET). Candidates must be within 2 seconds, share version keywords, and have case-insensitive artist token overlap. The bootstrap platform link is stored with `method: "fuzzy"`. If search finds no accepted hit, the API returns `404 not_found`.

Repeat lookups of the same input are served from the SQLite cache.

Rate limits are not enforced in this prototype; cache aggressively and keep MusicBrainz at ≤1 req/s via a built-in limiter. Review each provider ToS before commercial use.

## Entities

- **Recording**: `id`, `title`, `artists[]`, `duration_ms`, `mbid?`
- **Identifier**: `recording_id`, `kind` (`isrc` \| `spotify` \| `apple` \| `deezer` \| `tidal` \| `ytm` \| `musicbrainz` \| `query`), `value`
- **PlatformLink**: `id`, `recording_id`, `platform`, `url`, `duration_ms`, `confidence`, `method`, `verified_at`, `unmatched`
- **Correction**: `link_id?`, `recording_id?`, `reason` (`wrong` \| `missing`), `submitted_at`, `status`
