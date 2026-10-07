/**
 * Resolve known match-correctness seed cases against live DSPs.
 *
 * This hits live catalogs (Deezer/MusicBrainz always; Apple/Tidal/Spotify/YTM
 * when env keys are present). Do not call from default `npm test`.
 *
 * Durations default to the seed-archive named-cases.json values. Override with
 * CLI flags, e.g.:
 *   npm run dump:seed-cases -- --pigwig-ms=210000 --handson-ms=169000
 *
 * Usage: npm run dump:seed-cases
 */
import "dotenv/config";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { resolveTrack } from "../src/pipeline.ts";
import { createProviders } from "../src/providers/index.ts";

const DEFAULT_MS = {
  "oh-no-now-my": 188_000,
  billy: 189_000,
  syw: 167_000,
  pigwig: 210_000,
  handson: 169_000,
  dexter: 549_000,
  storm: 220_000,
  thicc: 223_000,
  "midnight-sun": 190_000,
  "spin-spin": 543_000,
  "al-90": 306_000,
} as const;

function durationOverride(flag: keyof typeof DEFAULT_MS): number {
  const prefix = `--${flag}-ms=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return DEFAULT_MS[flag];
  const n = Number(arg.slice(prefix.length));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MS[flag];
}

const cases = [
  {
    name: "This Is Lorelei — Oh No Now My",
    artist: "This Is Lorelei",
    title: "Oh No Now My",
    album: "Oh No Now My",
    duration_ms: durationOverride("oh-no-now-my"),
  },
  {
    name: "This Is Lorelei — Billy Came Back",
    artist: "This Is Lorelei",
    title: "Billy Came Back",
    album: "Oh No Now My",
    duration_ms: durationOverride("billy"),
  },
  {
    name: "Empress Of — SYW (feat. Cecile Believe)",
    artist: "Empress Of",
    title: "SYW (feat. Cecile Believe)",
    album: "SYW (feat. Cecile Believe)",
    duration_ms: durationOverride("syw"),
  },
  { name: "Bloc Party — Pigwig", artist: "Bloc Party", title: "Pigwig", album: "Pigwig", duration_ms: durationOverride("pigwig") },
  { name: "Empress Of — HandsOn", artist: "Empress Of", title: "HandsOn", album: "HandsOn", duration_ms: durationOverride("handson") },
  {
    name: "Ricardo Villalobos — Dexter",
    artist: "Ricardo Villalobos",
    title: "Dexter",
    album: "Dexter",
    duration_ms: durationOverride("dexter"),
  },
  {
    name: "Lord Of The Isles — Storm Mother",
    artist: "Lord Of The Isles",
    title: "Storm Mother",
    duration_ms: durationOverride("storm"),
  },
  {
    name: "Shygirl — thicc",
    artist: "Shygirl",
    title: "thicc",
    album: "thicc (Fedde Le Grand remix)",
    duration_ms: durationOverride("thicc"),
  },
  {
    name: "Zara Larsson — Midnight Sun",
    artist: "Zara Larsson",
    title: "Midnight Sun",
    album: "Midnight Sun",
    duration_ms: durationOverride("midnight-sun"),
  },
  {
    name: "Sneaker Pimps — Spin Spin Sugar",
    artist: "Sneaker Pimps",
    title: "Spin Spin Sugar",
    album: "Becoming Remixed",
    duration_ms: durationOverride("spin-spin"),
  },
  {
    name: "AL-90 — Завуалированный Сигнал",
    artist: "AL-90",
    title: "Завуалированный Сигнал",
    album: "Код-915913",
    duration_ms: durationOverride("al-90"),
  },
];

const db = new Store(":memory:");
const providers = createProviders(loadConfig());

const out = [];
for (const input of cases) {
  try {
    const result = await resolveTrack(
      { artist: input.artist, title: input.title, album: input.album, duration_ms: input.duration_ms },
      { db, providers },
    );
    out.push({
      input,
      title: result.recording.title,
      recording: result.recording,
      recording_confidence: result.recording_confidence,
      evidence: {
        matching_rule_version: result.evidence.matching_rule_version,
        commit: result.evidence.commit ?? null,
        cached: result.evidence.cached,
        recording_reused: result.evidence.recording_reused,
        reuse_via: result.evidence.reuse_via,
        query_match: result.evidence.query_match,
        source: result.evidence.source,
        destinations: result.evidence.destinations,
        providers_enabled: result.evidence.providers_enabled,
        credentials_skipped: result.evidence.credentials_skipped,
      },
      links: result.links.map((link) => ({
        platform: link.platform,
        method: link.method,
        confidence: link.confidence,
        url: link.url,
        unmatched: link.unmatched,
        skip_reason: link.skip_reason ?? null,
      })),
    });
  } catch (err) {
    out.push({
      input,
      error: {
        code: err && typeof err === "object" && "code" in err ? (err as { code: string }).code : "resolve_failed",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

console.log(JSON.stringify(out, null, 2));
db.close();
