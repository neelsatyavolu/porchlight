-- CONTRACT: Porchlight schema, SPEC §4.
-- Conventions:
--   * ids are client- or server-generated UUID strings (TEXT).
--   * every timestamp is INTEGER milliseconds since the Unix epoch, UTC,
--     set by the server. The API converts them to ISO 8601 strings.
--   * token columns hold lowercase hex SHA-256 of the raw token; raw tokens
--     are never stored.
--   * every query is scoped by user_id (SPEC §9).
--   * packages.updated_at: writers set it to
--     MAX(now, (SELECT MAX(updated_at) FROM packages WHERE user_id = ?) + 1)
--     (NEXT_UPDATED_AT in routes/packages.ts), so the sync cursor
--     (updated_at, id) is strictly increasing per user.
--   * on delete, the tombstone's tracking_number gets the suffix
--     ~deleted~<id>, so UNIQUE(user_id, carrier, tracking_number) lets the
--     number be tracked again under a new id. Lookups by number must filter
--     deleted_at IS NULL.
-- Additions beyond the SPEC §4 key columns are marked "added:".

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  apple_sub   TEXT UNIQUE,
  email       TEXT UNIQUE COLLATE NOCASE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE devices (
  id           TEXT PRIMARY KEY,           -- client-generated UUID
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL CHECK (platform IN ('ios', 'macos', 'web')),
  apns_token   TEXT,
  app_version  TEXT
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     TEXT,                      -- null for web sessions without a device row
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE packages (
  id               TEXT PRIMARY KEY,       -- client-generated UUID
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  carrier          TEXT NOT NULL,          -- CarrierId from @porchlight/carriers
  tracking_number  TEXT NOT NULL,          -- normalized (normalizeNumber)
  title            TEXT,
  merchant         TEXT,
  order_id         TEXT,
  source           TEXT NOT NULL CHECK (source IN ('manual', 'amazon', 'flint', 'share')),
  status           TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN (
                     'label_created', 'in_transit', 'out_for_delivery',
                     'available_for_pickup', 'delivered', 'exception',
                     'returned', 'unknown')),
  status_detail    TEXT,
  eta_start        INTEGER,
  eta_end          INTEGER,
  delivered_at     INTEGER,
  last_checked_at  INTEGER,
  next_check_at    INTEGER,                -- null = not polled (delivered, or no adapter)
  archived_at      INTEGER,
  deleted_at       INTEGER,                -- tombstone; row kept so sync can report it
  updated_at       INTEGER NOT NULL,       -- server time of last change; sync cursor
  UNIQUE (user_id, carrier, tracking_number)
);
CREATE INDEX packages_user_updated ON packages(user_id, updated_at, id);
CREATE INDEX packages_next_check ON packages(next_check_at) WHERE next_check_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE package_items (
  package_id  TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  image_url   TEXT,
  quantity    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX package_items_package ON package_items(package_id);

CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  package_id   TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  occurred_at  INTEGER NOT NULL,
  status       TEXT NOT NULL,
  description  TEXT NOT NULL,
  location     TEXT,
  raw_hash     TEXT NOT NULL,             -- sha256(occurred_at|status|description|location)
  UNIQUE (package_id, raw_hash)
);
CREATE INDEX events_package_time ON events(package_id, occurred_at);

CREATE TABLE imports (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source      TEXT NOT NULL CHECK (source IN ('amazon', 'flint')),
  dedupe_key  TEXT NOT NULL,              -- Flint message id, or Amazon "<order>:<shipment>"
  package_id  TEXT REFERENCES packages(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, source, dedupe_key)
);

CREATE TABLE api_tokens (
  id            TEXT PRIMARY KEY,         -- added: public id for GET/DELETE /v1/tokens
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,            -- e.g. "Flint on Neel's MacBook"
  scopes        TEXT NOT NULL,            -- space-separated, e.g. "imports:write"
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

-- added: short-lived one-time codes for email magic links and Flint pairing.
-- Not in SPEC §4; needed by POST /v1/auth/email/* and /v1/pairing/*.
CREATE TABLE auth_codes (
  code_hash    TEXT PRIMARY KEY,          -- sha256 of the emailed token or pairing code
  kind         TEXT NOT NULL CHECK (kind IN ('email', 'pairing')),
  email        TEXT COLLATE NOCASE,       -- kind = 'email'
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,  -- kind = 'pairing'
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);
CREATE INDEX auth_codes_expires ON auth_codes(expires_at);
