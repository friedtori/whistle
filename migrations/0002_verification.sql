-- Gum heavy-use verification handshake (see README "Verification").

-- Nonces issued in 429 verification_required challenges. Single use, 5 min TTL.
CREATE TABLE IF NOT EXISTS verification_nonces (
  nonce TEXT PRIMARY KEY,
  issued_at INTEGER NOT NULL,   -- ms since epoch
  expires_at INTEGER NOT NULL,  -- ms since epoch
  used_at INTEGER               -- ms since epoch; NULL until proven
);

CREATE INDEX IF NOT EXISTS verification_nonces_expires ON verification_nonces (expires_at);

-- Fixed-window request counters: anonymous per client network per hour,
-- verified per session per day.
CREATE TABLE IF NOT EXISTS quota_counters (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL, -- ms since epoch
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE INDEX IF NOT EXISTS quota_counters_window ON quota_counters (window_start);
