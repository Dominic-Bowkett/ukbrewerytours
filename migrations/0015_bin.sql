-- A bin, so that deleting a conversation is not the end of it.
--
-- Delete used to mean gone: one mis-click on the wrong row and a real customer's
-- history went with it. Now Delete sets deleted_at and the conversation sits in
-- the bin for seven days, where it can be read and put back, before the
-- scheduler removes it for good. "Delete forever" skips the wait.

ALTER TABLE enquiries ADD COLUMN deleted_at TEXT;

-- Two shapes of query: "everything not in the bin" (every list, on every
-- request) and "what is old enough to purge" (the scheduler, every five minutes).
CREATE INDEX IF NOT EXISTS idx_enquiries_deleted ON enquiries(deleted_at);
