-- Payment requests sent from an inbox conversation: "pay £5 for your top-up".
-- Logged against the conversation only — nothing here touches vouchers. The
-- customer opens /pay-now/<token>, which makes a fresh Stripe Checkout Session
-- each time (so the link never goes stale); the Stripe webhook marks it paid.
-- Kept when a conversation is deleted for good: a payment record is a payment record.

CREATE TABLE IF NOT EXISTS inbox_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,              -- 32 hex, in the customer's link
  amount_pence INTEGER NOT NULL,
  description TEXT NOT NULL,               -- shown on the Stripe page and the receipt
  status TEXT NOT NULL DEFAULT 'open',     -- open | paid | cancelled
  customer_email TEXT,
  stripe_session_id TEXT,                  -- the session that was paid
  stripe_payment_intent TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbox_payments_enquiry ON inbox_payments(enquiry_id);
