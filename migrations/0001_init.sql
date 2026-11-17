-- Whistle schema (ported from the node:sqlite store in src/db.ts).
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artists TEXT NOT NULL,
  duration_ms INTEGER,
  mbid TEXT,
  origin_confidence REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS recordings_mbid ON recordings (mbid);

CREATE TABLE IF NOT EXISTS identifiers (
  recording_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (kind, value),
  FOREIGN KEY (recording_id) REFERENCES recordings(id)
);

CREATE INDEX IF NOT EXISTS identifiers_recording ON identifiers (recording_id);

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
