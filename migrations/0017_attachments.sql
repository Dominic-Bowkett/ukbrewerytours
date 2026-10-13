-- Attachments on inbox messages: photos and files customers email in, and
-- files we attach to replies. The bytes live in R2 (MAIL_FILES binding, bucket
-- ukbrewerytours-mail); this table is the index.
--
-- inbound_id is Resend's id for a received email, kept so the attachments of a
-- message can be fetched again (backfill, or a retry after a failed save).
-- html_key is the R2 key of the email's original HTML body, for "View original".

CREATE TABLE IF NOT EXISTS enquiry_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id INTEGER NOT NULL,
  message_id INTEGER,                -- enquiry_messages.id it belongs to
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER,
  r2_key TEXT NOT NULL,
  content_id TEXT,                   -- cid: of an inline image, for the original HTML
  inline INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enquiry_attachments_enquiry ON enquiry_attachments(enquiry_id);
CREATE INDEX IF NOT EXISTS idx_enquiry_attachments_message ON enquiry_attachments(message_id);

ALTER TABLE enquiry_messages ADD COLUMN inbound_id TEXT;
ALTER TABLE enquiry_messages ADD COLUMN html_key TEXT;
