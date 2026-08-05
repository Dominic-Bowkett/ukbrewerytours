-- Gift voucher system — initial schema.
-- Apply with:  npx wrangler d1 migrations apply ukbrewerytours-vouchers --remote

-- One row per purchase (a purchase may cover several vouchers).
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,                       -- uuid, minted before Stripe redirect
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | paid
  email_sent INTEGER NOT NULL DEFAULT 0,     -- 0/1 — guards against double-sends on webhook retries
  quantity INTEGER NOT NULL,
  amount_pence INTEGER NOT NULL,             -- face value of ONE voucher
  total_pence INTEGER NOT NULL,              -- amount_pence * quantity
  purchaser_name TEXT,
  purchaser_email TEXT NOT NULL,
  recipient_name TEXT,
  recipient_email TEXT,                      -- null when send_to_self = 1
  send_to_self INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  tour_slug TEXT,                            -- tour page the voucher was bought from
  tour_name TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,        -- 1 = bought via the hidden demo page
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

-- One row per redeemable voucher code.
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,                 -- UBT-XXXX-XXXX
  amount_pence INTEGER NOT NULL,             -- original face value
  balance_pence INTEGER NOT NULL,            -- remaining value
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | active | partially_redeemed | redeemed | void
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_vouchers_code   ON vouchers(code);
CREATE INDEX IF NOT EXISTS idx_vouchers_order  ON vouchers(order_id);
CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);

-- Audit trail of every full/partial redemption.
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id INTEGER NOT NULL,
  amount_pence INTEGER NOT NULL,
  balance_after_pence INTEGER NOT NULL,
  redeemed_by TEXT,                          -- admin email
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_redemptions_voucher ON redemptions(voucher_id);

-- Admin logins for /admin/.
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,               -- PBKDF2-HMAC-SHA256, hex
  password_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 150000,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
