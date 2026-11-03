# Whistle

Hosted, developer-first music track resolver. Give it an ISRC, a platform track ID, a link that encodes one, or a title + artist + duration. Get back a **Recording**, `recording_confidence` (is this the right recording), and **PlatformLinks** for Apple Music, Deezer, Tidal, MusicBrainz, Spotify, and YouTube Music — each with destination `confidence` (0–1) and `method` (`isrc` | `isrc_from_fuzzy` | `mb_relation` | `fuzzy` | `user`).

Whistle is an API for apps (Gum consumes it via deep links). It is not a paste-a-link marketing page.

## Runtime

Whistle is a Cloudflare Worker (Hono) backed by D1. It is served only on its custom domain (`whistle.typetenor.com`, placeholder) with `workers_dev = false`, so zone WAF and rate-limit rules run before the Worker. First deploy steps are in [DEPLOY.md](DEPLOY.md).

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars        # optional; Deezer + MusicBrainz work with no keys
npm run db:migrate:local              # apply migrations/ to the local D1 database
npm run dev                           # wrangler dev → http://localhost:8787
```

```bash
curl 'http://localhost:8787/v1/resolve?isrc=USUG11904206'
curl 'http://localhost:8787/v1/resolve?url=https://www.deezer.com/track/916424'
curl 'http://localhost:8787/v1/resolve?platform=spotify&id=0VjIjW4GlUZAMYd2vXMi3b'
curl 'http://localhost:8787/v1/resolve?artist=The%20Weeknd&title=Blinding%20Lights&duration_ms=200040'
curl 'http://localhost:8787/v1/resolve?artist=Alanis%20Morissette&title=Ironic&album=Jagged%20Little%20Pill&duration_ms=230000'
```

```bash
npm test                        # vitest in workerd (@cloudflare/vitest-pool-workers), local D1, mocked providers
npm run typecheck
WHISTLE_LIVE_TESTS=1 npm test   # also hit public Deezer + MusicBrainz through the real Worker entry
```

`npm test` needs no Cloudflare account: Miniflare provides D1 (migrations are applied in `tests/apply-migrations.ts`) and the MusicBrainz Durable Object.

## Secrets

Set with `wrangler secret put <NAME>` in production and in `.dev.vars` locally. Never put them in `vars`. All are optional; a missing credential skips that platform and other platforms still resolve.

| Secret | Notes |
| --- | --- |
| `APPLE_PRIVATE_KEY` / `APPLE_TEAM_ID` / `APPLE_KEY_ID` | MusicKit developer token minted with `jose` (ES256, 12 h, cached per isolate). `APPLE_PRIVATE_KEY` is the `.p8` PEM (`\n` escaped or a single-line PEM is fine) |
| `APPLE_MUSIC_TOKEN` | Optional pre-built MusicKit developer JWT, used instead of minting one |
| `TIDAL_CLIENT_ID` / `TIDAL_CLIENT_SECRET` | Tidal Open API v2 client-credentials |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Spotify is resolved **last** and never trusted alone |
| `YOUTUBE_API_KEY` | YouTube Data API v3; YouTube Music is fuzzy-only |

## Vars (`wrangler.jsonc`)

| Var | Default | Notes |
| --- | --- | --- |
| `MUSICBRAINZ_USER_AGENT` | `Whistle/1.0 ( https://github.com/friedtori/whistle )` | Descriptive UA, required by MusicBrainz |
| `APPLE_STOREFRONT` | `us` | |
| `TIDAL_COUNTRY` | `US` | |
| `SUBREQUEST_LIMIT` | `1000` | Workers subrequest limit per invocation. **Set `50` on the Workers Free plan** |
| `RESOLVE_SUBREQUEST_CAP` | `40` | Most provider calls (fetch + MusicBrainz gate) one resolve may make; further calls are skipped like a provider miss |
| `BATCH_MAX_INPUTS` | `20` | `POST /v1/resolve/batch` input cap (max 100) |
| `MUSICBRAINZ_MIN_INTERVAL_MS` | `1100` | Spacing enforced by the MusicBrainz gate |
| `WHISTLE_GIT_COMMIT` | unset | Reported as `evidence.commit` |

When MusicKit catalog auth is configured, Apple lookups use the catalog API only (iTunes Search/Lookup is not used as a fallback, which avoids dead `/song/{id}` links). Without catalog auth, Apple uses public iTunes **lookup** (`lookup?id=` / `lookup?isrc=`). There is **no** `search?term=${isrc}` first-result fallback — that path returned unrelated songs whose ISRC was not the query. Deezer and MusicBrainz need no keys.

## Workers limits

- **Subrequests.** A Worker invocation fails outright once it exceeds the platform subrequest limit (1,000 on Workers Paid, 50 on Free). Each request gets a budget of `SUBREQUEST_LIMIT`. Each resolve may spend at most `RESOLVE_SUBREQUEST_CAP` (40) on provider calls, and 8 more are reserved for D1. **`POST /v1/resolve/batch` accepts at most 20 inputs** (`BATCH_MAX_INPUTS`): 20 × (40 + 8) = 960 ≤ 1,000. If a batch item would not fit in what is left of the budget, it is returned as `{ "ok": false, "error": { "code": "subrequest_budget_exhausted" } }` without being attempted. Retry those items in a new request. On the Free plan, set `SUBREQUEST_LIMIT=50`. A single GET then still fits (40 + 8), but a batch only gets through its first input.
- **D1 round trips.** A resolve uses a per-request unit of work. Each recording is loaded once (one `batch()`), all writes are committed in one `batch()` (a single D1 transaction), and the response is re-read once. That is about 4–8 D1 calls per fresh resolve and 2 for a cached one, instead of one call per pipeline step. A resolve that throws part-way writes nothing.
- **MusicBrainz ≤ 1 req/s.** A per-isolate limiter cannot enforce a global rate on Workers, so every MusicBrainz request goes through one `MusicBrainzGate` Durable Object instance. Each call reserves the next start slot `MUSICBRAINZ_MIN_INTERVAL_MS` apart. A call that would wait more than 4 s is refused, and that resolve skips MusicBrainz rather than stalling.
- **CPU time.** Matching is string work on at most a few dozen candidates per platform. The MusicKit JWT is signed once per isolate and reused for ~11.8 h, and OAuth tokens are cached per isolate. Free-plan CPU limits (10 ms) are tight for batches; Paid is recommended.

## API

All resolve responses include `recording`, `recording_confidence`, `identifiers`, `links[]` (`confidence` + `method` on every platform, including unmatched), `cached`, and `evidence` (rule version, reuse, query_match vs destinations, `providers_enabled`, `credentials_skipped` as a count — never tokens or keys).

`recording_confidence` is input→recording certainty (the fuzzy selection score for artist+title, `0.98` for a trusted ISRC, `1` for a direct platform+id on its own platform). `links[].confidence` / `links[].method` are destination-hop certainty. Teleport should treat `recording_confidence` as “is this the right recording” and `link.confidence`/`method` as “is this hop faithful.” An ISRC expansion from a fuzzy source stays `isrc_from_fuzzy` at `0.8 × 0.98` and does **not** raise `recording_confidence`.

Same version-family + duration is not identity by itself. In fuzzy acceptance, version-bearing titles must also agree after normalization, so two differently named remixes or live venues are rejected; two remasters with the same normalized title can still auto-match, and Teleport should still review that class. Remix vs acapella (and acapella vs the original) is rejected. Destination version keywords are read from **title + album + URL slug** (hyphens → spaces), so an Apple hit titled “Problem” whose URL/album says instrumental/cover/acoustic/karaoke is unmatched. A destination hop that contradicts the chosen recording is left unmatched with `skip_reason: destination_mismatch`.

Title normalization keeps Unicode letters and combining marks (NFKC, `\p{L}\p{M}\p{N}`); Latin-only stripping would drop Cyrillic titles (AL-90) to empty. Fuzzy acceptance does not implement transliteration: a non-Latin query title (気分上々) does not fuzzy-accept a Latin candidate (Kibun Jou Jou). The destination contradiction check, which only runs on hops whose identity already comes from an ISRC, MBID, or MusicBrainz relation, does not count a Latin/non-Latin title pair as a contradiction; artist overlap, duration, and version still apply there. Same-script unrelated titles (Pigwig vs Now We Can't Be Friends) reject in both.

`findOrCreateRecording` will not reuse an existing row found by ISRC/mbid/platform id unless `destinationMatchesRecording` passes. SYW/HandsOn must not inherit Wild Storm’s links. Write-once `origin_confidence` stays on the reused row; this query’s uncertainty lives on `evidence.query_match`. Cached resolves and `GET /v1/recordings/:id` mark `query_match.reason = reconstructed_from_cache` and leave `query_match.confidence` null — that is not a new measurement.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/resolve?isrc=` or `?platform=&id=` or `?url=` or `?artist=&title=&duration_ms=` (`album` optional) | Resolve one input |
| `POST` | `/v1/resolve/batch` | Up to 20 inputs (`BATCH_MAX_INPUTS`): `{ "inputs": [ { "isrc" }, { "platform", "id" }, { "url" }, { "artist", "title", "duration_ms", "album"? } ] }` |
| `GET` | `/v1/recordings/{id}` | Cached recording + links |
| `POST` | `/v1/corrections` | Flag a link: `{ "link_id", "reason": "wrong" }` or `{ "recording_id", "platform", "reason": "missing" }` |
| `GET` | `/health` | Liveness |

v1 platforms: `apple`, `deezer`, `tidal`, `musicbrainz`, `spotify`, `ytm`.

### Pipeline

1. Cache (exact input identifier, including a normalized `query` key for artist+title+duration, plus album when sent)
2. ISRC lookups (Deezer, Apple, Tidal, MusicBrainz) — or, for artist+title, a Deezer/Apple/Tidal search bootstrap that must pass the fuzzy gates. Seed/input ISRCs use `method: isrc` / `0.98`; a direct platform+id match on its own platform stays `1`. ISRCs discovered via a fuzzy MusicBrainz match are tagged `isrc_from_fuzzy` at `0.8 × 0.98` and are not stored as ISRC identifiers
3. MusicBrainz sibling ISRCs on the same recording (same provenance as the MB match), then a second ISRC pass that skips already-tried `(platform, isrc)` pairs
4. MusicBrainz URL relations
5. Fuzzy title/artist search — requires positive durations within 2 seconds, title token similarity ≥0.8, and primary-artist token similarity ≥0.8 (missing credits fail closed). Collapsed titles like `HandsOn` / `Hands On` count as equal. Unicode letters and combining marks are preserved with NFKC normalization; cross-script transliteration is not an acceptance path. Version families (`live`, `remix`, `edit`, `remaster`, `acoustic`, `instrumental`, `karaoke`, `cover`, `demo`, `session`, `acapella` / `a cappella`) must agree across title + album + URL slug; version-bearing titles must also agree after punctuation and spelling-alias normalization, so different named mixes or live venues are rejected. Deezer/Spotify/MusicBrainz retry a plain `artist title` query when the strict fielded search returns no **accepted** hit (not only when it returns no rows). MusicBrainz plain queries escape Lucene operators; Deezer quotes the plain query so `:` is not a field separator
   - **Destination contradiction check.** Every hop (ISRC, MusicBrainz relation, fuzzy) and every recording reuse is also checked against the chosen recording: title similarity ignoring parenthetical subtitles ≥0.5 (a Latin/non-Latin pair is not treated as a contradiction here, because the identity already comes from an identifier), version families on title + album + URL slug, duration within 2 s when both are known, and any artist overlap when both sides have artists. A hop that fails is left unmatched with `skip_reason: destination_mismatch
6. Spotify last (trusted ISRC, then `isrc_from_fuzzy`, then search). Never used as the sole authority for other platforms

Artist+title resolve is for listening-history rows that have no ISRC. **`duration_ms` is required** (or `duration` in seconds on GET). Bootstrap and all destination searches use the same fuzzy acceptance gates above. Optional `album` is a soft preference among accepted candidates: matching album titles win, and obvious compilations (`greatest hits`, `the collection`, …) are downranked unless they are the only match or the query album itself looks like a compilation. The bootstrap platform link is stored with `method: "fuzzy"` at the actual selection score. If search finds no accepted hit, the API returns `404 not_found`.

Fuzzy matching is conservative: reordered or differently formatted joint artist credits (for example a query artist of `A feat. B`) may be rejected, and cross-script transliteration is not implemented. Thresholds are heuristics, not calibrated probabilities. Existing cached resolutions are not revalidated by these gates; the gates apply when running a new search.

`npm run dump:seed-cases` resolves the named seed titles (including Oh No Now My, SYW, Pigwig, HandsOn, Dexter, Storm Mother, archive thicc, Midnight Sun, Spin Spin Sugar, AL-90) against live DSPs and prints JSON plus `evidence`. Durations default to archive values; pass `--pigwig-ms=` / `--handson-ms=` / `--dexter-ms=` etc. to override. Live-only Node script (reads `.dev.vars` when present, uses an in-memory SQLite stand-in for D1 and an in-process MusicBrainz limiter); not part of default `npm test`.

`npm run replay:seed-archive` reads archive JSONL (`--fuzzy=` / `--isrc=`, or `/tmp/whistle-seed` when present) and writes `artifacts/match-correctness/`. Default is **named cases** + `--dry-fixtures` (title floor / URL version evaluation, no DSP). Pass `--all` for the full 900+374 (pace MusicBrainz) and `--live` to call `resolveTrack`. Output includes `run_id`, timestamp, `git rev-parse HEAD`, `matching_rule_version`, `providers_enabled`, `credentials_skipped`. No secrets. See `artifacts/match-correctness/BEFORE_AFTER.md`.

Repeat lookups of the same input are served from the D1 cache.

Whistle itself does not rate-limit callers yet; rely on zone rate-limit rules in front of the custom domain. MusicBrainz is kept at ≤1 req/s globally by the `MusicBrainzGate` Durable Object. Review each provider ToS before commercial use.

## Entities

- **Recording**: `id`, `title`, `artists[]`, `duration_ms`, `mbid?`
- **Identifier**: `recording_id`, `kind` (`isrc` \| `spotify` \| `apple` \| `deezer` \| `tidal` \| `ytm` \| `musicbrainz` \| `query`), `value`
- **PlatformLink**: `id`, `recording_id`, `platform`, `url`, `duration_ms`, `confidence`, `method`, `verified_at`, `unmatched`, `skip_reason?` (`destination_mismatch` when a hop was found and refused)
- **Correction**: `link_id?`, `recording_id?`, `reason` (`wrong` \| `missing`), `submitted_at`, `status`
