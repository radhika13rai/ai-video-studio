-- 0006: public SaaS identity, sessions, email verification, plans and usage metering.
PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('pending_verification', 'active', 'suspended'));
ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- Existing Cloudflare Access users are trusted identities; preserve their access.
UPDATE users SET email_verified_at = created_at, account_status = 'active'
WHERE email_verified_at IS NULL;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_agent TEXT,
  ip_hash TEXT
);
CREATE INDEX auth_sessions_user_expiry ON auth_sessions(user_id, expires_at);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX email_verification_user ON email_verification_tokens(user_id, expires_at);

CREATE TABLE auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  expires_at TEXT NOT NULL
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(expires_at);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_price_usd INTEGER NOT NULL DEFAULT 0 CHECK (monthly_price_usd >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  limits_json TEXT NOT NULL CHECK (json_valid(limits_json)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO plans (id, name, monthly_price_usd, limits_json) VALUES
 ('free','Free',0,'{"projects_per_month":3,"generations_per_month":5,"max_duration_seconds":60,"max_scenes":20,"storage_bytes":1073741824,"concurrent_jobs":1}'),
 ('creator','Creator',1200,'{"projects_per_month":50,"generations_per_month":100,"max_duration_seconds":600,"max_scenes":80,"storage_bytes":53687091200,"concurrent_jobs":3}'),
 ('studio','Studio',4900,'{"projects_per_month":500,"generations_per_month":1000,"max_duration_seconds":1800,"max_scenes":200,"storage_bytes":536870912000,"concurrent_jobs":10}');

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL CHECK (status IN ('trialing','active','past_due','cancelled','incomplete')),
  billing_provider TEXT,
  provider_customer_id TEXT,
  provider_subscription_id TEXT UNIQUE,
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX subscriptions_user_status ON subscriptions(user_id, status, current_period_end);

CREATE TABLE tenant_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('project_created','generation_started','render_seconds','storage_bytes','provider_cost_microusd')),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  idempotency_key TEXT NOT NULL,
  period_start TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(user_id, metric, idempotency_key)
);
CREATE INDEX tenant_usage_period ON tenant_usage(user_id, metric, period_start);

CREATE TABLE billing_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  processed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(provider, provider_event_id)
);
