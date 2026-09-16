-- Two additions for the helpdesk, once info@ukbrewerytours.com is routed into it.
--
-- 1. Notifications. Most of what arrives at info@ is machine-written: Stripe
--    receipts, DesignMyNight bookings, Google security mail. None of it is a
--    customer waiting for an answer, so it is filed away from the inbox, never
--    alerted on, and never shown to a team member.
-- 2. An address book, so the admin can start an email to someone who has not
--    written in. Admin only — team members never see it.

-- Filed away from the inbox rather than deleted: Dom can still search for the
-- Stripe payout he half-remembers, and promote anything that turns out to matter.
ALTER TABLE enquiries ADD COLUMN is_notification INTEGER NOT NULL DEFAULT 0;

-- Why it was filed here ("from stripe.com", "bulk mail"), shown in the admin so
-- a wrong guess is visible rather than mysterious.
ALTER TABLE enquiries ADD COLUMN notification_reason TEXT;

-- Every inbox query filters on this column first, then orders by recency.
CREATE INDEX IF NOT EXISTS idx_enquiries_notification
  ON enquiries(is_notification, last_message_at);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,                          -- uuid
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  company TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_emailed_at TEXT
);

-- One row per address: saving a contact from the composer is an upsert, and a
-- duplicate would mean two cards for the same person drifting apart.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_email ON contacts(lower(email));
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(lower(name));
