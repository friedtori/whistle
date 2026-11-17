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
import type { SubrequestBudget } from "./http.ts";

export interface RecordingRow extends Recording {
  created_at: string;
  updated_at: string;
  origin_confidence: number | null;
}

export interface UpsertLinkInput {
  recordingId: string;
  platform: Platform;
  url: string | null;
  duration_ms: number | null;
  confidence: number;
  method: MatchMethod | null;
  unmatched: boolean;
  skip_reason?: string | null;
  verified_at?: string;
}

export interface CorrectionInput {
  link_id?: string | null;
  recording_id?: string | null;
  platform?: Platform | null;
  reason: "wrong" | "missing";
}

export type RecordingPatch = Partial<Pick<Recording, "title" | "artists" | "duration_ms" | "mbid">>;

export type NewRecording = Omit<Recording, "id"> & { id?: string; origin_confidence?: number | null };

/** Storage used by the resolve pipeline and the HTTP routes. Async end to end (D1). */
export interface Store {
  findRecordingById(id: string): Promise<RecordingRow | null>;
  findRecordingByMbid(mbid: string): Promise<RecordingRow | null>;
  findRecordingByIdentifier(kind: IdentifierKind, value: string): Promise<RecordingRow | null>;
  createRecording(input: NewRecording): Promise<RecordingRow>;
  setOriginConfidence(id: string, value: number): Promise<void>;
  updateRecording(id: string, patch: RecordingPatch): Promise<void>;
  addIdentifier(recordingId: string, kind: IdentifierKind, value: string): Promise<void>;
  listIdentifiers(recordingId: string): Promise<Identifier[]>;
  getLink(id: string): Promise<PlatformLink | null>;
  listLinks(recordingId: string): Promise<PlatformLink[]>;
  upsertLink(input: UpsertLinkInput): Promise<PlatformLink>;
  createCorrection(input: CorrectionInput): Promise<Correction>;
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

interface IdentifierRow {
  recording_id: string;
  kind: string;
  value: string;
}

// --- SQL (shared by the direct store and the per-resolve unit of work) -----

const SQL = {
  recordingById: "SELECT * FROM recordings WHERE id = ?",
  recordingByMbid: "SELECT * FROM recordings WHERE mbid = ? LIMIT 1",
  recordingByIdentifier: `SELECT r.* FROM recordings r
    JOIN identifiers i ON i.recording_id = r.id
    WHERE i.kind = ? AND i.value = ?`,
  identifiersFor: "SELECT recording_id, kind, value FROM identifiers WHERE recording_id = ?",
  linksFor: "SELECT * FROM platform_links WHERE recording_id = ?",
  linkById: "SELECT * FROM platform_links WHERE id = ?",
  linkFor: "SELECT * FROM platform_links WHERE recording_id = ? AND platform = ?",
  insertRecording: `INSERT INTO recordings
    (id, title, artists, duration_ms, mbid, origin_confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  setOriginConfidence: `UPDATE recordings SET origin_confidence = ?, updated_at = ?
    WHERE id = ? AND origin_confidence IS NULL`,
  updateRecording: `UPDATE recordings SET title = ?, artists = ?, duration_ms = ?, mbid = ?, updated_at = ?
    WHERE id = ?`,
  insertIdentifier: "INSERT OR IGNORE INTO identifiers (recording_id, kind, value) VALUES (?, ?, ?)",
  // A matched link is never replaced (same rule as the original store); the
  // WHERE keeps that true under concurrent resolves of one recording.
  upsertLink: `INSERT INTO platform_links
    (id, recording_id, platform, url, duration_ms, confidence, method, verified_at, unmatched, skip_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(recording_id, platform) DO UPDATE SET
      url = excluded.url,
      duration_ms = excluded.duration_ms,
      confidence = excluded.confidence,
      method = excluded.method,
      verified_at = excluded.verified_at,
      unmatched = excluded.unmatched,
      skip_reason = excluded.skip_reason
    WHERE platform_links.unmatched = 1`,
  insertCorrection: `INSERT INTO corrections (id, link_id, recording_id, platform, reason, submitted_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
} as const;

function toRecording(row: Record<string, unknown>): RecordingRow {
  const artistsRaw = row.artists;
  const artists = typeof artistsRaw === "string" ? (JSON.parse(artistsRaw) as string[]) : [];
  return {
    id: String(row.id),
    title: String(row.title),
    artists,
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    mbid: row.mbid == null ? null : String(row.mbid),
    origin_confidence: row.origin_confidence == null ? null : Number(row.origin_confidence),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function toLink(row: LinkRow): PlatformLink {
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

function toIdentifier(row: IdentifierRow): Identifier {
  return { recording_id: row.recording_id, kind: row.kind as IdentifierKind, value: row.value };
}

function newRecordingRow(input: NewRecording): RecordingRow {
  const now = new Date().toISOString();
  return {
    id: input.id ?? newId(),
    title: input.title,
    artists: input.artists,
    duration_ms: input.duration_ms,
    mbid: input.mbid,
    origin_confidence: input.origin_confidence ?? null,
    created_at: now,
    updated_at: now,
  };
}

function newLinkRow(input: UpsertLinkInput, id: string): PlatformLink {
  return {
    id,
    recording_id: input.recordingId,
    platform: input.platform,
    url: input.url,
    duration_ms: input.duration_ms,
    confidence: input.confidence,
    method: input.method,
    verified_at: input.verified_at ?? new Date().toISOString(),
    unmatched: input.unmatched,
    skip_reason: input.skip_reason ?? null,
  };
}

function patched(current: RecordingRow, patch: RecordingPatch): RecordingRow {
  return {
    ...current,
    title: patch.title ?? current.title,
    artists: patch.artists ?? current.artists,
    duration_ms: patch.duration_ms === undefined ? current.duration_ms : patch.duration_ms,
    mbid: patch.mbid === undefined ? current.mbid : patch.mbid,
    updated_at: new Date().toISOString(),
  };
}

class Statements {
  constructor(private readonly db: D1Database) {}

  insertRecording(row: RecordingRow): D1PreparedStatement {
    return this.db
      .prepare(SQL.insertRecording)
      .bind(
        row.id,
        row.title,
        JSON.stringify(row.artists),
        row.duration_ms,
        row.mbid,
        row.origin_confidence,
        row.created_at,
        row.updated_at,
      );
  }

  setOriginConfidence(id: string, value: number): D1PreparedStatement {
    return this.db.prepare(SQL.setOriginConfidence).bind(value, new Date().toISOString(), id);
  }

  updateRecording(row: RecordingRow): D1PreparedStatement {
    return this.db
      .prepare(SQL.updateRecording)
      .bind(row.title, JSON.stringify(row.artists), row.duration_ms, row.mbid, row.updated_at, row.id);
  }

  insertIdentifier(recordingId: string, kind: IdentifierKind, value: string): D1PreparedStatement {
    return this.db.prepare(SQL.insertIdentifier).bind(recordingId, kind, value);
  }

  upsertLink(link: PlatformLink): D1PreparedStatement {
    return this.db
      .prepare(SQL.upsertLink)
      .bind(
        link.id,
        link.recording_id,
        link.platform,
        link.url,
        link.duration_ms,
        link.confidence,
        link.method,
        link.verified_at,
        link.unmatched ? 1 : 0,
        link.skip_reason,
      );
  }
}

// --- Direct store ----------------------------------------------------------

/**
 * D1-backed store; every call is one D1 round trip (a `batch()` where the old
 * node:sqlite code ran several statements). The resolve pipeline does not use
 * this directly: `resolveTrack` opens a `ResolveUnit` via `unit()`.
 */
export class D1Store implements Store {
  private readonly stmts: Statements;

  constructor(
    readonly db: D1Database,
    private readonly budget?: SubrequestBudget,
  ) {
    this.stmts = new Statements(db);
  }

  /** Charge one D1 call to the request's subrequest budget. */
  charge(): void {
    this.budget?.charge(1);
  }

  /** A per-resolve unit of work over this database. */
  unit(): ResolveUnit {
    return new ResolveUnit(this);
  }

  get statements(): Statements {
    return this.stmts;
  }

  async findRecordingById(id: string): Promise<RecordingRow | null> {
    this.charge();
    const row = await this.db.prepare(SQL.recordingById).bind(id).first<Record<string, unknown>>();
    return row ? toRecording(row) : null;
  }

  async findRecordingByMbid(mbid: string): Promise<RecordingRow | null> {
    this.charge();
    const row = await this.db.prepare(SQL.recordingByMbid).bind(mbid).first<Record<string, unknown>>();
    return row ? toRecording(row) : null;
  }

  async findRecordingByIdentifier(kind: IdentifierKind, value: string): Promise<RecordingRow | null> {
    this.charge();
    const row = await this.db
      .prepare(SQL.recordingByIdentifier)
      .bind(kind, value)
      .first<Record<string, unknown>>();
    return row ? toRecording(row) : null;
  }

  /** Recording + identifiers + links in one round trip. */
  async loadRecording(
    id: string,
  ): Promise<{ recording: RecordingRow | null; identifiers: Identifier[]; links: PlatformLink[] }> {
    this.charge();
    const [rec, ids, links] = await this.db.batch([
      this.db.prepare(SQL.recordingById).bind(id),
      this.db.prepare(SQL.identifiersFor).bind(id),
      this.db.prepare(SQL.linksFor).bind(id),
    ]);
    const recRow = (rec.results as Record<string, unknown>[])[0];
    return {
      recording: recRow ? toRecording(recRow) : null,
      identifiers: (ids.results as unknown as IdentifierRow[]).map(toIdentifier),
      links: (links.results as unknown as LinkRow[]).map(toLink),
    };
  }

  async createRecording(input: NewRecording): Promise<RecordingRow> {
    const row = newRecordingRow(input);
    await this.run([this.stmts.insertRecording(row)]);
    return row;
  }

  async setOriginConfidence(id: string, value: number): Promise<void> {
    await this.run([this.stmts.setOriginConfidence(id, value)]);
  }

  async updateRecording(id: string, patch: RecordingPatch): Promise<void> {
    const current = await this.findRecordingById(id);
    if (!current) return;
    await this.run([this.stmts.updateRecording(patched(current, patch))]);
  }

  async addIdentifier(recordingId: string, kind: IdentifierKind, value: string): Promise<void> {
    await this.run([this.stmts.insertIdentifier(recordingId, kind, value)]);
  }

  async listIdentifiers(recordingId: string): Promise<Identifier[]> {
    this.charge();
    const { results } = await this.db.prepare(SQL.identifiersFor).bind(recordingId).all<IdentifierRow>();
    return results.map(toIdentifier);
  }

  async getLink(id: string): Promise<PlatformLink | null> {
    this.charge();
    const row = await this.db.prepare(SQL.linkById).bind(id).first<LinkRow>();
    return row ? toLink(row) : null;
  }

  async listLinks(recordingId: string): Promise<PlatformLink[]> {
    this.charge();
    const { results } = await this.db.prepare(SQL.linksFor).bind(recordingId).all<LinkRow>();
    return results.map(toLink);
  }

  async upsertLink(input: UpsertLinkInput): Promise<PlatformLink> {
    this.charge();
    const [, existing] = await this.db.batch([
      this.stmts.upsertLink(newLinkRow(input, newId())),
      this.db.prepare(SQL.linkFor).bind(input.recordingId, input.platform),
    ]);
    return toLink((existing.results as unknown as LinkRow[])[0]);
  }

  async createCorrection(input: CorrectionInput): Promise<Correction> {
    const id = newId();
    const submittedAt = new Date().toISOString();
    await this.run([
      this.db
        .prepare(SQL.insertCorrection)
        .bind(
          id,
          input.link_id ?? null,
          input.recording_id ?? null,
          input.platform ?? null,
          input.reason,
          submittedAt,
        ),
    ]);
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

  /** Execute statements atomically in one round trip. */
  async run(statements: D1PreparedStatement[]): Promise<void> {
    if (statements.length === 0) return;
    this.charge();
    if (statements.length === 1) {
      await statements[0].run();
      return;
    }
    await this.db.batch(statements);
  }
}

// --- Per-resolve unit of work -----------------------------------------------

/**
 * Keeps one resolve to a handful of D1 round trips instead of one per
 * pipeline step: each recording the pipeline touches is loaded once
 * (recording + identifiers + links in a single `batch()`), reads are served
 * from that snapshot, and writes are applied to the snapshot and queued.
 * `commit()` sends every queued write in one `batch()`, which D1 runs as a
 * single transaction, then drops the snapshot so the response is built from
 * what is actually stored.
 *
 * Identifier lookups always ask D1 first, so a pending `INSERT OR IGNORE`
 * that D1 would ignore cannot shadow the stored owner of an identifier.
 */
export class ResolveUnit implements Store {
  private readonly recordings = new Map<string, RecordingRow>();
  private readonly identifiers = new Map<string, Identifier[]>();
  private readonly links = new Map<string, PlatformLink[]>();
  private pending: D1PreparedStatement[] = [];

  constructor(private readonly base: D1Store) {}

  private get stmts(): Statements {
    return this.base.statements;
  }

  private async ensureLoaded(id: string): Promise<boolean> {
    if (this.recordings.has(id)) return true;
    const loaded = await this.base.loadRecording(id);
    if (!loaded.recording) return false;
    this.recordings.set(id, loaded.recording);
    this.identifiers.set(id, loaded.identifiers);
    this.links.set(id, loaded.links);
    return true;
  }

  private adopt(row: RecordingRow | null): RecordingRow | null {
    if (!row) return null;
    return this.recordings.get(row.id) ?? row;
  }

  async findRecordingById(id: string): Promise<RecordingRow | null> {
    return (await this.ensureLoaded(id)) ? this.recordings.get(id)! : null;
  }

  async findRecordingByMbid(mbid: string): Promise<RecordingRow | null> {
    const stored = this.adopt(await this.base.findRecordingByMbid(mbid));
    if (stored) return stored;
    for (const row of this.recordings.values()) if (row.mbid === mbid) return row;
    return null;
  }

  async findRecordingByIdentifier(kind: IdentifierKind, value: string): Promise<RecordingRow | null> {
    const stored = this.adopt(await this.base.findRecordingByIdentifier(kind, value));
    if (stored) return stored;
    for (const [id, list] of this.identifiers) {
      if (list.some((item) => item.kind === kind && item.value === value)) {
        return this.recordings.get(id) ?? null;
      }
    }
    return null;
  }

  async createRecording(input: NewRecording): Promise<RecordingRow> {
    const row = newRecordingRow(input);
    this.recordings.set(row.id, row);
    this.identifiers.set(row.id, []);
    this.links.set(row.id, []);
    this.pending.push(this.stmts.insertRecording(row));
    return row;
  }

  async setOriginConfidence(id: string, value: number): Promise<void> {
    const current = await this.findRecordingById(id);
    if (!current || current.origin_confidence != null) return;
    this.recordings.set(id, { ...current, origin_confidence: value });
    this.pending.push(this.stmts.setOriginConfidence(id, value));
  }

  async updateRecording(id: string, patch: RecordingPatch): Promise<void> {
    const current = await this.findRecordingById(id);
    if (!current) return;
    const next = patched(current, patch);
    this.recordings.set(id, next);
    this.pending.push(this.stmts.updateRecording(next));
  }

  async addIdentifier(recordingId: string, kind: IdentifierKind, value: string): Promise<void> {
    if (!(await this.ensureLoaded(recordingId))) return;
    const list = this.identifiers.get(recordingId)!;
    if (list.some((item) => item.kind === kind && item.value === value)) return;
    list.push({ recording_id: recordingId, kind, value });
    this.pending.push(this.stmts.insertIdentifier(recordingId, kind, value));
  }

  async listIdentifiers(recordingId: string): Promise<Identifier[]> {
    if (!(await this.ensureLoaded(recordingId))) return [];
    return [...this.identifiers.get(recordingId)!];
  }

  async getLink(id: string): Promise<PlatformLink | null> {
    for (const list of this.links.values()) {
      const found = list.find((link) => link.id === id);
      if (found) return found;
    }
    return this.base.getLink(id);
  }

  async listLinks(recordingId: string): Promise<PlatformLink[]> {
    if (!(await this.ensureLoaded(recordingId))) return [];
    return [...this.links.get(recordingId)!];
  }

  async upsertLink(input: UpsertLinkInput): Promise<PlatformLink> {
    await this.ensureLoaded(input.recordingId);
    const list = this.links.get(input.recordingId) ?? [];
    const existing = list.find((link) => link.platform === input.platform);
    if (existing && !existing.unmatched) return existing;
    const next = newLinkRow(input, existing?.id ?? newId());
    this.links.set(input.recordingId, [...list.filter((link) => link !== existing), next]);
    this.pending.push(this.stmts.upsertLink(next));
    return next;
  }

  createCorrection(input: CorrectionInput): Promise<Correction> {
    return this.base.createCorrection(input);
  }

  /** Number of writes waiting for `commit()`. */
  get pendingWrites(): number {
    return this.pending.length;
  }

  /** Write everything in one transaction, then forget the snapshot. */
  async commit(): Promise<void> {
    const statements = this.pending;
    this.pending = [];
    this.recordings.clear();
    this.identifiers.clear();
    this.links.clear();
    await this.base.run(statements);
  }
}
