-- ETA contract (docs/API.md "Packages"): eta_date_only = 1 means eta_start and
-- eta_end hold calendar dates, stored as milliseconds at 00:00 UTC of that
-- date and sent to clients as "YYYY-MM-DD". 0 means they are instants.
ALTER TABLE packages ADD COLUMN eta_date_only INTEGER NOT NULL DEFAULT 0 CHECK (eta_date_only IN (0, 1));

-- Backfill. Before this migration every carrier date ("2026-11-10") was
-- parsed to midnight UTC, and no carrier adapter produced a timed ETA at
-- exactly midnight UTC, so an ETA whose every bound sits on a UTC day
-- boundary came from a date. Amazon ETAs come from the device and could be
-- real instants, so they are left as they are.
UPDATE packages SET eta_date_only = 1
WHERE source != 'amazon'
  AND (eta_start IS NOT NULL OR eta_end IS NOT NULL)
  AND (eta_start IS NULL OR eta_start % 86400000 = 0)
  AND (eta_end IS NULL OR eta_end % 86400000 = 0);
