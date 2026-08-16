-- Funnel events for the voucher conversion report in /admin/.
--
-- Only OPENS need storing: every started checkout is already an `orders` row
-- (status 'pending' = abandoned, 'paid' = purchased), each tagged with the
-- widget it came from (widget_id null = ukbrewerytours.com itself). An open is:
--   * the site's voucher pop-up being opened (once per page view), or
--   * an embedded voucher widget being rendered on a host site (once per load,
--     and only when genuinely iframed — admin previews don't count).

CREATE TABLE IF NOT EXISTS widget_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,                       -- 'open' (room for more later)
  widget_id TEXT,                            -- null = the site's own voucher pop-up
  page TEXT,                                 -- page it happened on (path or host URL)
  ip TEXT,                                   -- for the per-IP flood cap only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wevents_created ON widget_events(created_at);
CREATE INDEX IF NOT EXISTS idx_wevents_widget  ON widget_events(widget_id, event, created_at);
-- Supports the per-IP hourly cap without scanning.
CREATE INDEX IF NOT EXISTS idx_wevents_ip_created ON widget_events(ip, created_at);
