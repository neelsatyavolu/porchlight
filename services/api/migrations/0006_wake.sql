-- Background checks (src/poll/wake.ts): when the server last sent this user's
-- iPhones a silent "check now" push.
ALTER TABLE users ADD COLUMN wake_sent_at INTEGER;
