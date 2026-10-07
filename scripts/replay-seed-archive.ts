/**
 * Replay seed-archive JSONL against current matching rules.
 *
 * Default: named cases only, --dry-fixtures (no DSP).
 *   npm run replay:seed-archive
 *   npm run replay:seed-archive -- --dry-fixtures --out=artifacts/match-correctness/named-replay.json
 *
 * Live resolve (needs provider env):
 *   npm run replay:seed-archive -- --live
 *
 * Full 900+374 only with --all (pace MusicBrainz).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  destinationMatchesRecording,
  destinationVersionText,
  evaluateFuzzy,
  isTransliterationPair,
  titleSimilarity,
  TITLE_SIMILARITY_FLOOR,
  versionKeywordsConflict,
} from "../src/fuzzy.ts";
import { MATCHING_RULE_VERSION } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const namedPath = resolve(repoRoot, "tests/fixtures/seed-archive/named-cases.json");

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = args.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function has(name: string): boolean {
  return args.includes(`--${name}`);
}

const dry = !has("live") || has("dry-fixtures");
const all = has("all");
const outPath = resolve(
  repoRoot,
  flag("out") ?? "artifacts/match-correctness/named-replay.json",
);
const fuzzyPath = resolve(
  flag("fuzzy") ??
    (existsSync("/tmp/whistle-seed/results-fuzzy.jsonl")
      ? "/tmp/whistle-seed/results-fuzzy.jsonl"
      : resolve(repoRoot, "tests/fixtures/seed-archive/results-fuzzy.jsonl")),
);
const isrcPath = resolve(
  flag("isrc") ??
    (existsSync("/tmp/whistle-seed/results-isrc.jsonl")
      ? "/tmp/whistle-seed/results-isrc.jsonl"
      : resolve(repoRoot, "tests/fixtures/seed-archive/results-isrc.jsonl")),
);

const named = JSON.parse(readFileSync(namedPath, "utf8")) as {
  fuzzy_identity_conflicts: Array<{
    input_key: string;
    archive_row: number;
    artist: string;
    title: string;
    album: string;
    duration_ms: number;
    archive_returned_title: string;
  }>;
  destination_apple_conflicts: Array<{
    archive_row: number;
    isrc: string;
    source_artist: string;
    source_title: string;
    archive_recording_title: string;
    apple_url: string;
    apple_page_title?: string;
    apple_page_artist?: string;
  }>;
  version_review: Array<{
    input_key: string;
    archive_row: number;
    artist: string;
    title: string;
    album: string;
    duration_ms: number;
    archive_returned_title: string;
    note: string;
  }>;
  positive_controls: Array<{
    archive_row: number;
    artist: string;
    title: string;
    album: string;
    duration_ms: number;
    archive_returned_title: string;
  }>;
  wild_storm_seed: { isrc: string; title: string; artist: string };
};

type ArchiveFuzzy = {
  key: string;
  artist: string;
  track: string;
  album: string;
  duration_ms: number;
  ok: boolean;
  recording_id: string | null;
  title: string | null;
  artists: string[] | null;
  matched: Array<{ platform: string; method: string; confidence: number; url: string }>;
  unmatched: Array<{ platform: string; skip_reason?: string }>;
};

type ArchiveIsrc = {
  isrc: string;
  artist: string;
  track: string;
  ok: boolean;
  recording_id: string | null;
  title: string | null;
  artists: string[] | null;
  matched: Array<{ platform: string; method: string; confidence: number; url: string }>;
  unmatched: Array<{ platform: string; skip_reason?: string }>;
};

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

function gitCommit(): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function intendedFuzzy(row: ArchiveFuzzy): {
  intended: "accept" | "reject" | "version-review";
  title_similarity: number;
  title_floor: boolean;
  version_conflict: boolean;
  reason: string;
} {
  const source = { title: row.track, album: row.album, duration_ms: row.duration_ms, artists: row.artist };
  const candidateTitle = row.title ?? "";
  const sim = candidateTitle ? titleSimilarity(row.track, candidateTitle) : 0;
  const decision = candidateTitle
    ? evaluateFuzzy(source, {
        title: candidateTitle,
        artists: row.artists ?? [],
        duration_ms: row.duration_ms,
        // Archive rows omit dest album; reuse query album so "Becoming Remixed"
        // can contribute remix for dry analysis of the returned title.
        album: row.album,
      })
    : { accepted: false, confidence: 0, reason: "missing_archive_title" };
  const version = candidateTitle ? versionKeywordsConflict(row.track, candidateTitle) : false;
  const midnight = row.key === "zara larsson\tmidnight sun\tmidnight sun\t190000";
  if (midnight) {
    return {
      intended: "version-review",
      title_similarity: sim,
      title_floor: sim >= TITLE_SIMILARITY_FLOOR,
      version_conflict: version,
      reason: "Super Loud is not a known version family; accept-only-hit or prefer bare title",
    };
  }
  const floorPassed =
    sim >= TITLE_SIMILARITY_FLOOR ||
    (Boolean(candidateTitle) && isTransliterationPair(row.track, candidateTitle));
  if (!decision.accepted) {
    return {
      intended: "reject",
      title_similarity: sim,
      title_floor: floorPassed,
      version_conflict: version || decision.reason === "version_keyword",
      reason: decision.reason ?? "rejected",
    };
  }
  return {
    intended: "accept",
    title_similarity: sim,
    title_floor: floorPassed,
    version_conflict: false,
    reason: "identity passed",
  };
}

function appleDestEval(
  row: ArchiveIsrc,
  conflict: {
    apple_url: string;
    apple_page_title?: string;
    apple_page_artist?: string;
    archive_recording_title: string;
  },
) {
  const apple = row.matched.find((link) => link.platform === "apple");
  const recording = {
    title: row.title ?? conflict.archive_recording_title,
    artists: row.artists ?? [row.artist],
    duration_ms: null as number | null,
  };
  const hit = {
    title: conflict.apple_page_title ?? row.title ?? conflict.archive_recording_title,
    artists: conflict.apple_page_artist ? [conflict.apple_page_artist] : (row.artists ?? [row.artist]),
    duration_ms: null as number | null,
    url: conflict.apple_url,
    album: conflict.apple_page_title ?? null,
  };
  const scan = destinationVersionText(hit);
  return {
    archive_accepted: Boolean(apple),
    archive_url: apple?.url ?? null,
    version_scan: scan,
    version_conflict: versionKeywordsConflict(recording.title, scan),
    destination_matches: destinationMatchesRecording(recording, hit),
    intended: "unmatched" as const,
    reason: "destination_mismatch",
  };
}

const fuzzyRows = readJsonl<ArchiveFuzzy>(fuzzyPath);
const isrcRows = readJsonl<ArchiveIsrc>(isrcPath);
const namedFuzzyKeys = new Set([
  ...named.fuzzy_identity_conflicts.map((row) => row.input_key),
  ...named.version_review.map((row) => row.input_key),
  "sneaker pimps\tspin spin sugar\tbecoming remixed\t543000",
  "al-90\tзавуалированный сигнал\tкод-915913\t306000",
]);
const selectedFuzzy = all
  ? fuzzyRows
  : fuzzyRows.filter((row) => namedFuzzyKeys.has(row.key));

function syntheticFuzzy(
  artist: string,
  title: string,
  album: string,
  duration_ms: number,
  archiveTitle: string,
): ArchiveFuzzy {
  return {
    key: `${artist.toLowerCase()}\t${title.toLowerCase()}\t${album.toLowerCase()}\t${duration_ms}`,
    artist,
    track: title,
    album,
    duration_ms,
    ok: true,
    recording_id: null,
    title: archiveTitle,
    artists: [artist],
    matched: [],
    unmatched: [],
  };
}

const fuzzyFromNamed: ArchiveFuzzy[] =
  selectedFuzzy.length > 0
    ? selectedFuzzy
    : [
        ...named.fuzzy_identity_conflicts.map((row) =>
          syntheticFuzzy(row.artist, row.title, row.album, row.duration_ms, row.archive_returned_title),
        ),
        ...named.version_review.map((row) =>
          syntheticFuzzy(row.artist, row.title, row.album, row.duration_ms, row.archive_returned_title),
        ),
        ...named.positive_controls.map((row) =>
          syntheticFuzzy(row.artist, row.title, row.album, row.duration_ms, row.archive_returned_title),
        ),
      ];

const cases = [
  ...fuzzyFromNamed.map((row, index) => {
    const evaled = intendedFuzzy(row);
    return {
      kind: "fuzzy" as const,
      archive_row: fuzzyRows.indexOf(row) + 1 || undefined,
      input_key: row.key,
      artist: row.artist,
      title: row.track,
      album: row.album,
      duration_ms: row.duration_ms,
      archive: {
        ok: row.ok,
        recording_id: row.recording_id,
        title: row.title,
        matched: row.matched,
        unmatched: row.unmatched,
      },
      dry: evaled,
      index,
    };
  }),
  ...named.destination_apple_conflicts.map((conflict) => {
    const row = isrcRows.find((item) => item.isrc === conflict.isrc);
    return {
      kind: "isrc-dest" as const,
      archive_row: conflict.archive_row,
      isrc: conflict.isrc,
      artist: conflict.source_artist,
      title: conflict.source_title,
      archive: row
        ? { ok: row.ok, recording_id: row.recording_id, title: row.title, matched: row.matched }
        : { ok: true, recording_id: null, title: conflict.archive_recording_title, matched: [] },
      dry: row
        ? appleDestEval(row, conflict)
        : {
            archive_accepted: true,
            archive_url: conflict.apple_url,
            version_scan: destinationVersionText({ title: conflict.archive_recording_title, url: conflict.apple_url }),
            version_conflict: true,
            destination_matches: false,
            intended: "unmatched" as const,
            reason: "destination_mismatch",
          },
    };
  }),
];

const commit = gitCommit();
const payload = {
  run_id: `dry-named-${new Date().toISOString().slice(0, 10)}`,
  timestamp: new Date().toISOString(),
  commit: commit ?? null,
  matching_rule_version: MATCHING_RULE_VERSION,
  mode: dry ? "dry-fixtures" : "live",
  scoped: all ? "all" : "named",
  providers_enabled: dry ? [] : ["deezer", "musicbrainz"],
  credentials_skipped: dry ? 0 : null,
  archive_paths: {
    fuzzy: existsSync(fuzzyPath) ? fuzzyPath : null,
    isrc: existsSync(isrcPath) ? isrcPath : null,
  },
  cases,
};

if (!dry) {
  const { loadConfig } = await import("../src/config.ts");
  const { Store } = await import("../src/db.ts");
  const { resolveTrack } = await import("../src/pipeline.ts");
  const { createProviders } = await import("../src/providers/index.ts");
  const providers = createProviders(loadConfig());
  payload.providers_enabled = Object.entries(providers)
    .filter(([, provider]) => provider.enabled)
    .map(([name]) => name);
  payload.credentials_skipped = Object.values(providers).filter((provider) => !provider.enabled).length;
  for (const item of payload.cases) {
    const db = new Store(":memory:");
    try {
      const result =
        item.kind === "fuzzy"
          ? await resolveTrack(
              { artist: item.artist, title: item.title, album: item.album, duration_ms: item.duration_ms },
              { db, providers },
            )
          : await resolveTrack({ isrc: item.isrc }, { db, providers });
      (item as Record<string, unknown>).live = {
        ok: true,
        title: result.recording.title,
        recording_id: result.recording.id,
        evidence: result.evidence,
      };
    } catch (err) {
      (item as Record<string, unknown>).live = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      db.close();
    }
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Wrote ${outPath} (${payload.cases.length} cases, mode=${payload.mode})`);
