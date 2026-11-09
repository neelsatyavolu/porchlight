-- Tracking sources, device tracking and aggregator budget
-- (docs/research/scraping.md, docs/API.md "Device tracking").

-- added: where the current status came from: 'api', 'web', 'aggregator'
-- (the adapter's `source`), 'device' (POST /v1/packages/:id/observed) or
-- 'amazon' (the Amazon import's observed block). Null until something is read.
-- Sent as `dataSource`; with carrier 'dhl', 'api' also drives `attribution`.
ALTER TABLE packages ADD COLUMN last_source TEXT
  CHECK (last_source IN ('api', 'web', 'aggregator', 'device', 'amazon'));

-- added: the earliest time a native app should read this package's carrier
-- page (usps, fedex, and ups once web:ups is blocked). Null = no device read
-- wanted. The poller sets it when the per-package cadence is due; a
-- challenged/failed device report pushes it later (backoff); an ok/not_found
-- report clears it. GET /v1/device-tracking/due returns rows where
-- device_needed_at <= now, oldest first.
ALTER TABLE packages ADD COLUMN device_needed_at INTEGER;
-- added: why device_needed_at was set ('new', 'scheduled', 'manual',
-- 'server_blocked'); sent as the job's `reason`.
ALTER TABLE packages ADD COLUMN device_reason TEXT
  CHECK (device_reason IN ('new', 'scheduled', 'manual', 'server_blocked'));
-- added: consecutive challenged/failed device reports; reset by ok/not_found.
ALTER TABLE packages ADD COLUMN device_failures INTEGER NOT NULL DEFAULT 0;

-- added: consecutive failed server checks (any adapter), for exponential
-- backoff up to 2 h. Reset by a successful check.
ALTER TABLE packages ADD COLUMN check_failures INTEGER NOT NULL DEFAULT 0;
-- added: consecutive not_found or permanent failures from the carrier's web
-- adapter. At 2 or more the aggregator may be tried (budget permitting).
ALTER TABLE packages ADD COLUMN web_misses INTEGER NOT NULL DEFAULT 0;
-- added: when this number was registered with the aggregator (Ship24). The
-- first registration spends one of the month's AGGREGATOR_MONTHLY_LIMIT;
-- later reads of a registered tracker don't.
ALTER TABLE packages ADD COLUMN aggregator_registered_at INTEGER;

-- added: when the DHL-terms purge deleted this package's events (events of
-- DHL-API packages go DHL_RETENTION_DAYS after delivered_at). Null = not purged.
ALTER TABLE packages ADD COLUMN events_purged_at INTEGER;

CREATE INDEX packages_device_needed ON packages(user_id, device_needed_at)
  WHERE device_needed_at IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX packages_dhl_purge ON packages(delivered_at)
  WHERE carrier IN ('dhl', 'dhl_ecommerce') AND last_source = 'api' AND delivered_at IS NOT NULL AND events_purged_at IS NULL;
