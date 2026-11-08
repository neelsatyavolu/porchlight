-- GET/DELETE /v1/sessions and per-device APNs environment (docs/API.md).

-- added: public session id. token_hash stays the primary key and is never
-- sent to clients. Nullable only because ALTER TABLE cannot add a column with
-- a random default; createSession always sets it.
ALTER TABLE sessions ADD COLUMN id TEXT;
-- added: the client that signed in ('ios', 'macos', 'web'), shown when the
-- session has no device row (web). Null for sessions made before this column.
ALTER TABLE sessions ADD COLUMN client TEXT CHECK (client IN ('ios', 'macos', 'web'));

UPDATE sessions SET id =
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
WHERE id IS NULL;
CREATE UNIQUE INDEX sessions_id ON sessions(id);

-- added: which APNs host serves this device. Development builds get tokens
-- for api.sandbox.push.apple.com, App Store and TestFlight builds for
-- api.push.apple.com, and a token only works on its own host.
ALTER TABLE devices ADD COLUMN apns_environment TEXT NOT NULL DEFAULT 'production'
  CHECK (apns_environment IN ('sandbox', 'production'));
