-- Refunds: money back to the customer's card via Stripe, tracked per voucher.
-- Distinct from `redemptions`, which record value spent on a tour.

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id INTEGER NOT NULL,
  order_id TEXT NOT NULL,
  amount_pence INTEGER NOT NULL,
  stripe_refund_id TEXT,
  reason TEXT,                                -- requested_by_customer | duplicate | fraudulent
  note TEXT,
  refunded_by TEXT,                           -- admin email
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_refunds_voucher ON refunds(voucher_id);
CREATE INDEX IF NOT EXISTS idx_refunds_order   ON refunds(order_id);

-- Running total of money refunded against a voucher. The balance is reduced by
-- the same amount, so a refunded voucher cannot also be redeemed.
ALTER TABLE vouchers ADD COLUMN refunded_pence INTEGER NOT NULL DEFAULT 0;
