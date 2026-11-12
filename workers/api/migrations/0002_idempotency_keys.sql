-- Migration 0002: idempotency keys, so clients can safely retry POST requests.
-- A row is reserved (status_code NULL) before the work runs and filled in afterwards.
-- Rows older than 24 hours are deleted opportunistically by the application.

CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idem_key TEXT NOT NULL CHECK (length(idem_key) BETWEEN 1 AND 255),
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, idem_key)
);

CREATE INDEX idx_idempotency_created ON idempotency_keys(user_id, created_at);
