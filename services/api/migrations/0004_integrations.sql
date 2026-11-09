-- Amazon import status (docs/API.md "Integrations", SPEC §6 "Failure is visible").
-- One row per user and integration. A device reports after each import; the
-- latest report wins. Holds no Amazon data: only a state, times and one
-- sentence of error text.
CREATE TABLE integrations (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('amazon')),
  state           TEXT NOT NULL CHECK (state IN ('ok', 'needs_sign_in', 'parse_failed')),
  last_import_at  INTEGER,
  last_error      TEXT,
  -- the platform of the device that sent the report ('ios', 'macos', 'web')
  platform        TEXT CHECK (platform IN ('ios', 'macos', 'web')),
  reported_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);
