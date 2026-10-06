import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Correction,
  Identifier,
  IdentifierKind,
  MatchMethod,
  Platform,
  PlatformLink,
  Recording,
} from "./types.ts";
import { newId } from "./ids.ts";

export interface RecordingRow extends Recording {
  created_at: string;
  updated_at: string;
}

interface IdentifierRow {
  recording_id: string;
  kind: string;
  value: string;
}

interface LinkRow {
  id: string;
  recording_id: string;
  platform: string;
  url: string | null;
  duration_ms: number | null;
  confidence: number;
  method: string | null;
  verified_at: string;
  unmatched: number;
  skip_reason: string | null;
}

export class Store {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.raw = new DatabaseSync(path);
    if (path !== ":memory:") {
      this.raw.exec("PRAGMA journal_mode = WAL;");
    }
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.raw.close();
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        artists TEXT NOT NULL,
        duration_ms INTEGER,
        mbid TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS identifiers (
        recording_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (kind, value),
        FOREIGN KEY (recording_id) REFERENCES recordings(id)
      );

      CREATE TABLE IF NOT EXISTS platform_links (
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        url TEXT,
        duration_ms INTEGER,
        confidence REAL NOT NULL,
        method TEXT,
        verified_at TEXT NOT NULL,
        unmatched INTEGER NOT NULL DEFAULT 0,
        skip_reason TEXT,
        UNIQUE (recording_id, platform),
        FOREIGN KEY (recording_id) REFERENCES recordings(id)
      );

      CREATE TABLE IF NOT EXISTS corrections (
        id TEXT PRIMARY KEY,
        link_id TEXT,
        recording_id TEXT,
        platform TEXT,
        reason TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      );
    `);
  }

  findRecordingById(id: string): RecordingRow | null {
    const row = this.raw.prepare("SELECT * FROM recordings WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toRecording(row) : null;
  }

  findRecordingByMbid(mbid: string): RecordingRow | null {
    const row = this.raw.prepare("SELECT * FROM recordings WHERE mbid = ?").get(mbid) as
      | Record<string, unknown>
      | undefined;
    return row ? this.toRecording(row) : null;
  }

  findRecordingByIdentifier(kind: IdentifierKind, value: string): RecordingRow | null {
    const row = this.raw
      .prepare(
        `SELECT r.* FROM recordings r
         JOIN identifiers i ON i.recording_id = r.id
         WHERE i.kind = ? AND i.value = ?`,
      )
      .get(kind, value) as Record<string, unknown> | undefined;
    return row ? this.toRecording(row) : null;
  }

  createRecording(input: Omit<Recording, "id"> & { id?: string }): RecordingRow {
    const now = new Date().toISOString();
    const id = input.id ?? newId();
    this.raw
      .prepare(
        `INSERT INTO recordings (id, title, artists, duration_ms, mbid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        JSON.stringify(input.artists),
        input.duration_ms,
        input.mbid,
        now,
        now,
      );
    return this.findRecordingById(id)!;
  }

  updateRecording(
    id: string,
    patch: Partial<Pick<Recording, "title" | "artists" | "duration_ms" | "mbid">>,
  ): void {
    const current = this.findRecordingById(id);
    if (!current) return;
    const next = {
      title: patch.title ?? current.title,
      artists: patch.artists ?? current.artists,
      duration_ms: patch.duration_ms === undefined ? current.duration_ms : patch.duration_ms,
      mbid: patch.mbid === undefined ? current.mbid : patch.mbid,
    };
    this.raw
      .prepare(
        `UPDATE recordings SET title = ?, artists = ?, duration_ms = ?, mbid = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        JSON.stringify(next.artists),
        next.duration_ms,
        next.mbid,
        new Date().toISOString(),
        id,
      );
  }

  addIdentifier(recordingId: string, kind: IdentifierKind, value: string): void {
    this.raw
      .prepare(
        `INSERT OR IGNORE INTO identifiers (recording_id, kind, value) VALUES (?, ?, ?)`,
      )
      .run(recordingId, kind, value);
  }

  listIdentifiers(recordingId: string): Identifier[] {
    const rows = this.raw
      .prepare("SELECT recording_id, kind, value FROM identifiers WHERE recording_id = ?")
      .all(recordingId) as unknown as IdentifierRow[];
    return rows.map((row) => ({
      recording_id: row.recording_id,
      kind: row.kind as IdentifierKind,
      value: row.value,
    }));
  }

  getLink(id: string): PlatformLink | null {
    const row = this.raw.prepare("SELECT * FROM platform_links WHERE id = ?").get(id) as
      | LinkRow
      | undefined;
    return row ? this.toLink(row) : null;
  }

  listLinks(recordingId: string): PlatformLink[] {
    const rows = this.raw
      .prepare("SELECT * FROM platform_links WHERE recording_id = ?")
      .all(recordingId) as unknown as LinkRow[];
    return rows.map((row) => this.toLink(row));
  }

  upsertLink(input: {
    recordingId: string;
    platform: Platform;
    url: string | null;
    duration_ms: number | null;
    confidence: number;
    method: MatchMethod | null;
    unmatched: boolean;
    skip_reason?: string | null;
    verified_at?: string;
  }): PlatformLink {
    const existing = this.raw
      .prepare("SELECT * FROM platform_links WHERE recording_id = ? AND platform = ?")
      .get(input.recordingId, input.platform) as LinkRow | undefined;

    if (existing && existing.unmatched === 0 && !input.unmatched) {
      return this.toLink(existing);
    }
    if (existing && existing.unmatched === 0 && input.unmatched) {
      return this.toLink(existing);
    }

    const id = existing?.id ?? newId();
    const verifiedAt = input.verified_at ?? new Date().toISOString();
    this.raw
      .prepare(
        `INSERT INTO platform_links
          (id, recording_id, platform, url, duration_ms, confidence, method, verified_at, unmatched, skip_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(recording_id, platform) DO UPDATE SET
           url = excluded.url,
           duration_ms = excluded.duration_ms,
           confidence = excluded.confidence,
           method = excluded.method,
           verified_at = excluded.verified_at,
           unmatched = excluded.unmatched,
           skip_reason = excluded.skip_reason`,
      )
      .run(
        id,
        input.recordingId,
        input.platform,
        input.url,
        input.duration_ms,
        input.confidence,
        input.method,
        verifiedAt,
        input.unmatched ? 1 : 0,
        input.skip_reason ?? null,
      );
    return this.getLink(id)!;
  }

  createCorrection(input: {
    link_id?: string | null;
    recording_id?: string | null;
    platform?: Platform | null;
    reason: "wrong" | "missing";
  }): Correction {
    const id = newId();
    const submittedAt = new Date().toISOString();
    this.raw
      .prepare(
        `INSERT INTO corrections (id, link_id, recording_id, platform, reason, submitted_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        id,
        input.link_id ?? null,
        input.recording_id ?? null,
        input.platform ?? null,
        input.reason,
        submittedAt,
      );
    return {
      id,
      link_id: input.link_id ?? null,
      recording_id: input.recording_id ?? null,
      platform: input.platform ?? null,
      reason: input.reason,
      submitted_at: submittedAt,
      status: "pending",
    };
  }

  private toRecording(row: Record<string, unknown>): RecordingRow {
    const artistsRaw = row.artists;
    const artists =
      typeof artistsRaw === "string" ? (JSON.parse(artistsRaw) as string[]) : [];
    return {
      id: String(row.id),
      title: String(row.title),
      artists,
      duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
      mbid: row.mbid == null ? null : String(row.mbid),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private toLink(row: LinkRow): PlatformLink {
    return {
      id: row.id,
      recording_id: row.recording_id,
      platform: row.platform as Platform,
      url: row.url,
      duration_ms: row.duration_ms,
      confidence: row.confidence,
      method: row.method as MatchMethod | null,
      verified_at: row.verified_at,
      unmatched: row.unmatched === 1,
      skip_reason: row.skip_reason,
    };
  }
}
