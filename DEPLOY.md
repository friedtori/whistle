# Deploying Whistle

The first deploy of the Cloudflare Worker. Run these from the repo root on a machine logged in to the Cloudflare account that owns the `typetenor.com` zone. Every command is idempotent unless noted otherwise.

`whistle.typetenor.com` is a placeholder hostname. To rename it, change `routes[0].pattern` in `wrangler.jsonc` before step 4.

## 0. Prerequisites

```bash
npm ci
npx wrangler login            # or export CLOUDFLARE_API_TOKEN=… (Workers Scripts, D1, Zone DNS edit)
npx wrangler whoami
```

There must be no existing DNS record for `whistle.typetenor.com`. A custom-domain deploy creates its own record and certificate, and fails if one already exists.

## 1. Create the D1 database (once)

```bash
npx wrangler d1 create whistle
```

Copy the printed `database_id` into `wrangler.jsonc` → `d1_databases[0].database_id`, replacing `00000000-0000-0000-0000-000000000000`, and commit that change.

## 2. Apply migrations

```bash
npx wrangler d1 migrations apply whistle --remote
```

Run this again after any PR that adds a file under `migrations/`, and before deploying that PR.

## 3. Choose the plan limits

`wrangler.jsonc` assumes **Workers Paid** (1,000 subrequests per invocation). On the Free plan, set `"SUBREQUEST_LIMIT": "50"` under `vars` before deploying. See README → Workers limits for how this caps `POST /v1/resolve/batch`.

## 4. Deploy

```bash
npx wrangler deploy
```

This uploads the Worker, creates the `MusicBrainzGate` Durable Object class (migration tag `v1`), and attaches the custom domain `whistle.typetenor.com`. `workers.dev` and preview URLs stay disabled (`workers_dev: false`, `preview_urls: false`), so the Worker is reachable only through the zone, behind its WAF and rate-limiting rules.

`migrations/0002_verification.sql` (nonces and quota counters) is applied in step 2 along with `0001`.

Without secrets the Worker already resolves through Deezer and MusicBrainz. Apple uses the public iTunes lookup, and Tidal, Spotify and YouTube Music are skipped.

## 5. Secrets

Each `secret put` prompts for the value, or reads it from stdin, and creates a new Worker version right away.

**Required:** `SESSION_SECRET`, the HMAC key for verified Gum sessions. Without it, Gum installs over the anonymous quota cannot verify (`/auth/session` returns 503).

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

Provider credentials are optional. Set only the platforms you want; a missing credential skips that platform.

```bash
npx wrangler secret put APPLE_TEAM_ID
npx wrangler secret put APPLE_KEY_ID
npx wrangler secret put APPLE_PRIVATE_KEY < AuthKey_XXXXXXXXXX.p8
npx wrangler secret put TIDAL_CLIENT_ID
npx wrangler secret put TIDAL_CLIENT_SECRET
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
npx wrangler secret put YOUTUBE_API_KEY
```

Optional: `npx wrangler secret put APPLE_MUSIC_TOKEN` stores a pre-built MusicKit JWT, which is used instead of minting one from the key.

```bash
npx wrangler secret list
```

## 6. Quotas and zone protection

Whistle meters resolves itself: `ANON_RESOLVES_PER_HOUR` (60) per client network, then a 429 verification challenge; `VERIFIED_RESOLVES_PER_DAY` (2000) per verified Gum session. These are `vars` in `wrangler.jsonc`, so retuning them is an edit plus `npx wrangler deploy`.

As with `api.typetenor.com`, keep a coarse WAF rate-limiting rule on `whistle.typetenor.com` in front of it. Set it well above the Whistle quotas so it only stops floods.

## 7. Verify

```bash
curl -sS https://whistle.typetenor.com/health
curl -sS 'https://whistle.typetenor.com/v1/resolve?isrc=USUG11904206' | head -c 600
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://whistle.typetenor.com/auth/session -d '{}'   # expect 400
npx wrangler tail
```

`evidence.providers_enabled` in a resolve response lists the platforms that have credentials.

## Later deploys

```bash
npx wrangler d1 migrations apply whistle --remote   # only if migrations/ changed
npx wrangler deploy
```
