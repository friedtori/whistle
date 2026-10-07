/**
 * Resolve the five known match-correctness seed cases against live DSPs.
 *
 * This hits live catalogs (Deezer/MusicBrainz always; Apple/Tidal/Spotify/YTM
 * when env keys are present). Do not call from default `npm test`.
 *
 * Durations below are representative placeholders, not measured from a
 * specific catalog. Override with CLI flags, e.g.:
 *   npm run dump:seed-cases -- --pigwig-ms=210000 --handson-ms=198000
 *
 * Usage: npm run dump:seed-cases
 */
import "dotenv/config";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { resolveTrack } from "../src/pipeline.ts";
import { createProviders } from "../src/providers/index.ts";

const DEFAULT_MS = {
  pigwig: 210_000,
  handson: 200_000,
  dexter: 400_000,
  storm: 220_000,
  thicc: 200_000,
} as const;

function durationOverride(flag: keyof typeof DEFAULT_MS): number {
  const prefix = `--${flag}-ms=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return DEFAULT_MS[flag];
  const n = Number(arg.slice(prefix.length));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_MS[flag];
}

const cases = [
  { name: "Bloc Party — Pigwig", artist: "Bloc Party", title: "Pigwig", duration_ms: durationOverride("pigwig") },
  { name: "Empress Of — HandsOn", artist: "Empress Of", title: "HandsOn", duration_ms: durationOverride("handson") },
  {
    name: "Ricardo Villalobos — Dexter",
    artist: "Ricardo Villalobos",
    title: "Dexter",
    duration_ms: durationOverride("dexter"),
  },
  {
    name: "Lord Of The Isles — Storm Mother",
    artist: "Lord Of The Isles",
    title: "Storm Mother",
    duration_ms: durationOverride("storm"),
  },
  {
    name: "Shygirl — thicc (Fedde Le Grand remix)",
    artist: "Shygirl",
    title: "thicc (Fedde Le Grand remix)",
    duration_ms: durationOverride("thicc"),
  },
];

const db = new Store(":memory:");
const providers = createProviders(loadConfig());

const out = [];
for (const input of cases) {
  try {
    const result = await resolveTrack(
      { artist: input.artist, title: input.title, duration_ms: input.duration_ms },
      { db, providers },
    );
    out.push({
      input,
      title: result.recording.title,
      recording: result.recording,
      recording_confidence: result.recording_confidence,
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
