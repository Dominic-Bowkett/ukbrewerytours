-- Contact-form enquiries. Kept so nothing is lost if an email bounces, and
-- so the endpoint can rate limit by IP.

CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  page TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_enquiries_created ON enquiries(created_at);
-- Supports the per-IP hourly count without scanning the table.
CREATE INDEX IF NOT EXISTS idx_enquiries_ip_created ON enquiries(ip, created_at);
