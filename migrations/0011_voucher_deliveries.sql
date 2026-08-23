-- Delivery log: every time a voucher email is sent for an order, including
-- resends from the admin when a buyer mistyped the recipient's address.
--
-- `orders.email_sent` only records *that* an email went out; this records
-- where each one went, so a corrected address has an audit trail.

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  sent_to TEXT NOT NULL,                     -- address this send actually went to
  recipient_name TEXT,
  kind TEXT NOT NULL DEFAULT 'resend',       -- initial | resend
  address_updated INTEGER NOT NULL DEFAULT 0,-- 1 = the order's stored address was corrected too
  previous_email TEXT,                       -- what it was before the correction
  note TEXT,
  sent_by TEXT,                              -- admin email, null for the automatic first send
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deliveries_order ON deliveries(order_id);
