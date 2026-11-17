-- 0007: password recovery and account lifecycle support.
PRAGMA foreign_keys = ON;

CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX password_reset_user_expiry ON password_reset_tokens(user_id, expires_at);

CREATE TABLE account_deletion_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  requested_at TEXT NOT NULL,
  scheduled_deletion_at TEXT NOT NULL,
  cancelled_at TEXT,
  completed_at TEXT
);

CREATE UNIQUE INDEX subscriptions_one_live_per_user
  ON subscriptions(user_id)
  WHERE status IN ('trialing', 'active', 'past_due', 'incomplete');
