-- Enquiry inbox: every form, widget and chat message becomes a conversation
-- the admin can triage (status, type, site) and reply to from info@.
--
-- enquiries stays the conversation header (one row per enquiry, as before);
-- enquiry_messages holds the thread — the original message, admin replies,
-- customer follow-ups (chat, the /messages/ page, inbound email) and notes.

ALTER TABLE enquiries ADD COLUMN type TEXT NOT NULL DEFAULT 'general';   -- redemption | group | booking | voucher | general
ALTER TABLE enquiries ADD COLUMN channel TEXT NOT NULL DEFAULT 'form';   -- form | widget | chat | email
ALTER TABLE enquiries ADD COLUMN site TEXT NOT NULL DEFAULT 'ukbrewerytours.com'; -- host the enquiry came from, no www
ALTER TABLE enquiries ADD COLUMN status TEXT NOT NULL DEFAULT 'new';     -- new | dealing | waiting | closed
ALTER TABLE enquiries ADD COLUMN unread INTEGER NOT NULL DEFAULT 1;      -- 1 = customer wrote since the admin last opened it
ALTER TABLE enquiries ADD COLUMN token TEXT;                             -- 32 hex; unlocks /messages/<token> + chat + reply address
ALTER TABLE enquiries ADD COLUMN subject TEXT;
ALTER TABLE enquiries ADD COLUMN fields TEXT;                            -- JSON: tour, preferred date, group size…
ALTER TABLE enquiries ADD COLUMN voucher_code TEXT;                      -- as typed by the customer
ALTER TABLE enquiries ADD COLUMN last_message_at TEXT;
ALTER TABLE enquiries ADD COLUMN last_inbound_at TEXT;
ALTER TABLE enquiries ADD COLUMN alerted_at TEXT;                        -- last alert email to Dom (throttles chat bursts)
ALTER TABLE enquiries ADD COLUMN closed_at TEXT;

CREATE TABLE IF NOT EXISTS enquiry_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id INTEGER NOT NULL,
  direction TEXT NOT NULL,        -- in (customer) | out (admin reply) | note (internal) | event (status change, redemption)
  channel TEXT NOT NULL,          -- form | widget | chat | web | email | admin
  body TEXT NOT NULL,
  author TEXT,                    -- customer name, or the admin's email
  email_id TEXT,                  -- Resend id for outbound replies
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (enquiry_id) REFERENCES enquiries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_enquiry_messages_enquiry ON enquiry_messages(enquiry_id, id);
CREATE INDEX IF NOT EXISTS idx_enquiry_messages_ip ON enquiry_messages(ip, created_at);

-- Backfill the enquiries received before the inbox existed. They were all
-- emailed to info@ and handled there, so they arrive closed and read.
INSERT INTO enquiry_messages (enquiry_id, direction, channel, body, author, ip, created_at)
SELECT id, 'in', CASE WHEN widget_id IS NOT NULL THEN 'widget' ELSE 'form' END, message, name, ip, created_at
FROM enquiries;

UPDATE enquiries SET
  token = lower(hex(randomblob(16))),
  status = 'closed',
  closed_at = created_at,
  unread = 0,
  last_message_at = created_at,
  last_inbound_at = created_at,
  channel = CASE WHEN widget_id IS NOT NULL THEN 'widget' ELSE 'form' END,
  site = CASE
    WHEN coalesce(widget_origin, page, '') LIKE '%londonbrewerytour%' THEN 'londonbrewerytour.com'
    WHEN coalesce(widget_origin, page, '') LIKE '%bristolbrewerytours%' THEN 'bristolbrewerytours.com'
    WHEN coalesce(widget_origin, '') LIKE 'http%' THEN replace(replace(replace(widget_origin, 'https://', ''), 'http://', ''), 'www.', '')
    ELSE 'ukbrewerytours.com' END,
  type = CASE
    WHEN coalesce(page, '') LIKE '%/redeem%' OR message LIKE 'Voucher code:%' THEN 'redemption'
    WHEN coalesce(page, '') LIKE '%group%' OR coalesce(page, '') LIKE '%private%' THEN 'group'
    ELSE 'general' END,
  voucher_code = CASE WHEN message LIKE 'Voucher code: %' AND instr(message, char(10)) > 15
    THEN trim(substr(message, 15, instr(message, char(10)) - 15)) END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_enquiries_token ON enquiries(token);
CREATE INDEX IF NOT EXISTS idx_enquiries_status_last ON enquiries(status, last_message_at);

-- Redemptions made from an enquiry link back to it.
ALTER TABLE redemptions ADD COLUMN enquiry_id INTEGER;

-- Voucher codes issued by OTHER systems (uploaded as CSV from the admin), so a
-- redemption request quoting one can be checked and redeemed in the same place.
-- Value is optional: some systems sell "a tour for two", not an amount.
CREATE TABLE IF NOT EXISTS imported_vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,                 -- e.g. "GiftUp", "Buyagift"
  code TEXT NOT NULL,                   -- as supplied
  code_norm TEXT NOT NULL,              -- upper-case, letters and digits only
  description TEXT,
  amount_pence INTEGER,
  balance_pence INTEGER,
  status TEXT NOT NULL DEFAULT 'active',   -- active | partially_redeemed | redeemed | void
  holder_name TEXT,
  holder_email TEXT,
  purchased_at TEXT,
  expires_at TEXT,
  notes TEXT,
  raw TEXT,                             -- the original CSV row as JSON
  batch_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, code_norm)
);

CREATE INDEX IF NOT EXISTS idx_imported_vouchers_code ON imported_vouchers(code_norm);
CREATE INDEX IF NOT EXISTS idx_imported_vouchers_batch ON imported_vouchers(batch_id);

CREATE TABLE IF NOT EXISTS imported_voucher_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_voucher_id INTEGER NOT NULL,
  amount_pence INTEGER,                 -- null when the code carries no value
  balance_after_pence INTEGER,
  status_after TEXT NOT NULL,
  redeemed_by TEXT,
  note TEXT,
  enquiry_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (imported_voucher_id) REFERENCES imported_vouchers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_imported_redemptions_voucher ON imported_voucher_redemptions(imported_voucher_id);
