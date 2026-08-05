-- ===========================================================================
-- 0004_connect.sql — team payment requests via Stripe Connect DIRECT charges.
--
-- Apply with:  npx wrangler d1 migrations apply ukbrewerytours-vouchers --remote
--
-- This is the ONLY 0004. It supersedes every earlier draft (0004_team_payments,
-- and the first cut of this file). Nothing in the feature has ever run against
-- production data, so the file opens by dropping the tables it owns rather than
-- using CREATE TABLE IF NOT EXISTS — a no-op CREATE over a divergent shape is
-- how "no such column" turns up mid-payment instead of at deploy time. Every
-- CREATE below is unconditional and therefore authoritative: if a table already
-- exists in some other shape, this migration replaces it.
--
-- Requires a wrangler whose SQL splitter understands CREATE TRIGGER … BEGIN …
-- END (wrangler >= 3.0). If yours mangles them, apply the file directly with
--   npx wrangler d1 execute ukbrewerytours-vouchers --remote --file=migrations/0004_connect.sql
-- and verify with  SELECT name FROM sqlite_master WHERE type='trigger';
-- The triggers are NOT optional — they are the only thing that makes the
-- frozen-terms guarantee real (see the TRIGGERS section for why a CHECK cannot).
--
-- CONVENTIONS carried over from 0001–0003:
--   * money is INTEGER pence, never a float;
--   * timestamps are TEXT in SQLite's datetime('now') shape,
--     'YYYY-MM-DD HH:MM:SS' in UTC, so string comparison IS time comparison;
--   * every lifecycle column is an explicit status string guarded by a CHECK;
--   * concurrency is conditional UPDATEs (meta.changes), never transactions;
--   * idempotency is the two-flag pattern: a status guard for the money write
--     and a separate *_email_sent flag for the outbound mail.
--
-- CONVENTIONS new in 0004:
--   * every primary key is a TEXT uuid (crypto.randomUUID()), except where the
--     natural key is already an unforgeable string minted by Stripe (cs_…,
--     evt_…) or a canonical address. No AUTOINCREMENT integers: sequential ids
--     are enumerable, they collide with admin_users.id in a session payload, and
--     a mixed INTEGER/TEXT key space is what makes an ownership helper bind
--     Number('9f1c2a3e-…') = NaN and silently match nothing.
--   * percentages are INTEGER basis points (fee_bps): 2000 = 20.00%. A REAL
--     percent would be the one float in an integer-only money path, and 12.5%
--     must be expressible. functions/_lib/fees.js is already written to this.
--   * ON DELETE: nothing financial is ever cascaded away. team_members and
--     clients are RESTRICT (deactivate, never delete); sessions and refunds are
--     RESTRICT (they are the audit trail of real money); only the event log
--     CASCADEs, because an event without its request is meaningless.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 0. No reset.
--
-- An earlier draft of this file opened with DROP TABLE IF EXISTS over all
-- eleven tables, on the reasoning that none had ever held production data.
-- That was true the day it was written and stops being true the moment the
-- first payment request is created — after which re-running this migration
-- would delete real payment records, refund history and the audit trail that
-- reconciles money already taken on a connected account.
--
-- Migrations are re-run by hand more often than anyone plans (a fresh local
-- database, a rebuilt preview, an operator who is not sure whether it applied).
-- So the drops are gone and every CREATE below is IF NOT EXISTS: applying this
-- file twice is a no-op, never a data loss.
--
-- If the schema genuinely needs to change after this ships, that is a NEW
-- numbered migration with an explicit ALTER — not an edit to this one.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. platform_settings — one row; the last resort in the fee chain and the
--    home of the kill switches.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),        -- exactly one row, enforced by the PK CHECK

  default_fee_bps INTEGER NOT NULL DEFAULT 2000
    CHECK (default_fee_bps BETWEEN 0 AND 10000),  -- 2000 = 20%, INCLUDED in the price
  default_terms TEXT,                           -- snapshotted onto each request at send time
  default_expiry_days INTEGER NOT NULL DEFAULT 30
    CHECK (default_expiry_days > 0),
  pay_page_notice TEXT,

  -- Kill switch, read by the scheduler on every tick.
  send_enabled INTEGER NOT NULL DEFAULT 1 CHECK (send_enabled IN (0, 1)),

  -- Authoritative live/test flag. Deliberately NOT derived from the secret key
  -- prefix: a rotation to a restricted key (rk_live_…) fails a startsWith
  -- ('sk_live_') test and would silently invert livemode, making the Connect
  -- webhook 200-and-discard every real event.
  live_mode INTEGER NOT NULL DEFAULT 0 CHECK (live_mode IN (0, 1)),

  -- How stale a cached Stripe account state may be before the send path
  -- re-fetches GET /v1/accounts/{id} instead of sending blind.
  account_staleness_hours INTEGER NOT NULL DEFAULT 24 CHECK (account_staleness_hours > 0),

  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT                               -- admin email
);

-- OR IGNORE, not a bare INSERT: re-applying the migration must not fail on the
-- singleton row, and must never reset a fee percent the admin has since changed.
INSERT OR IGNORE INTO platform_settings (id, default_fee_bps, default_expiry_days) VALUES (1, 2000, 30);


-- ---------------------------------------------------------------------------
-- 2. team_members — logins for /team/, one Stripe connected account each.
--
--    A separate table from admin_users, with a separate cookie and a separate
--    signing secret, so a team session is structurally incapable of satisfying
--    an admin route. The uuid primary key matters here: admin_users.id is
--    INTEGER AUTOINCREMENT, so integer team ids would collide from 1 upward and
--    a session payload carrying uid=1 would name a real admin.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,                          -- uuid
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name TEXT NOT NULL,
  company_name TEXT,                            -- 'Alehunters Ltd' — the charge is in their name
  reply_to_email TEXT,                          -- client replies go here, not to the platform
  phone TEXT,

  -- Auth. 100000 is the Workers PBKDF2 ceiling and the CHECK makes storing a
  -- larger number impossible: admin_users says 150000 and is only survivable
  -- because hashPassword() clamps on both write and read. A row that lies about
  -- its own iteration count is a verification failure waiting to happen.
  password_hash TEXT NOT NULL,                  -- PBKDF2-HMAC-SHA256, hex
  password_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 100000 CHECK (iterations BETWEEN 1 AND 100000),
  -- Which scheme produced password_hash. Verification must DISPATCH on this
  -- value, never reject on it: an early `algo <> current` return runs no KDF and
  -- turns the constant-work login into a timing oracle that answers backwards
  -- (an unknown email costs ~100ms, a known-but-stale one costs microseconds).
  --   'pbkdf2-sha256'    — legacy; password fed to PBKDF2 directly
  --   'pbkdf2-sha256-p1' — password HMAC'd with TEAM_PASSWORD_PEPPER first
  algo TEXT NOT NULL DEFAULT 'pbkdf2-sha256-p1'
    CHECK (algo IN ('pbkdf2-sha256', 'pbkdf2-sha256-p1')),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  password_changed_at TEXT,

  -- Stateless-token revocation. The middleware re-reads this row on every
  -- request and rejects any token whose epoch is behind. Admin bumps it in the
  -- SAME statement that deactivates, resets a password or reassigns an account,
  -- so a live session dies on its next request instead of at expiry.
  session_epoch INTEGER NOT NULL DEFAULT 1 CHECK (session_epoch > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),

  -- Per-account throttle. SECONDARY to the per-IP throttle in login_attempts: an
  -- account-only lockout is a remote denial of service on the money path for
  -- anyone who knows the member's work email, so this backs off gently and the
  -- password is still verified while locked (a correct one clears it).
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  last_failed_at INTEGER,                       -- unix seconds
  locked_until INTEGER,                         -- unix seconds

  -- Connect wiring. ADMIN-ONLY writes; no /api/team/ route may touch these.
  -- UNIQUE stops one acct_ backing two members — that would mean B invoicing
  -- under A's legal entity and into A's bank account.
  stripe_account_id TEXT UNIQUE,                -- acct_… e.g. acct_1IpYpgJ48IaKbIcX
  stripe_account_label TEXT,                    -- most accounts have no business_profile.name

  -- charges_enabled ALONE is not "can this member take our money". A Standard
  -- account can have charges_enabled = 1 while the platform_payments capability
  -- is inactive: ordinary charges still work, only application_fee_amount is
  -- refused — so the member sends happily and the client hits an error at the
  -- moment of payment. Both are required before a send or a checkout.
  stripe_charges_enabled INTEGER NOT NULL DEFAULT 0 CHECK (stripe_charges_enabled IN (0, 1)),
  stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (stripe_payouts_enabled IN (0, 1)),
  stripe_platform_payments TEXT                 -- capabilities.platform_payments (or .transfers)
    CHECK (stripe_platform_payments IS NULL
           OR stripe_platform_payments IN ('active', 'pending', 'inactive')),
  stripe_card_payments TEXT
    CHECK (stripe_card_payments IS NULL
           OR stripe_card_payments IN ('active', 'pending', 'inactive')),
  -- 'deauthorized' is set from account.application.deauthorized. A Standard
  -- account holder can disconnect us from their own dashboard at any moment and
  -- nothing else in the payload says so.
  stripe_account_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (stripe_account_state IN ('unknown', 'active', 'restricted', 'deauthorized')),
  stripe_account_checked_at TEXT                -- freshness bound; re-fetch when stale
    CHECK (stripe_account_checked_at IS NULL
           OR stripe_account_checked_at LIKE '____-__-__ __:__:__'),
  deauthorized_at TEXT,

  fee_bps INTEGER CHECK (fee_bps IS NULL OR fee_bps BETWEEN 0 AND 10000),  -- NULL = platform default
  terms_override TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Login is by email; the UNIQUE constraint indexes it. So does the Connect
-- webhook's lookup by acct_ id (stripe_account_id UNIQUE).
CREATE INDEX IF NOT EXISTS idx_team_members_active  ON team_members(active, name);
CREATE INDEX IF NOT EXISTS idx_team_members_account ON team_members(stripe_account_id);
-- Admin sweep: who is sendable right now?
CREATE INDEX IF NOT EXISTS idx_team_members_sendable ON team_members(stripe_account_state, active)
  WHERE stripe_charges_enabled = 1;


-- ---------------------------------------------------------------------------
-- 3. clients — a member's address book, so a repeat request is one click.
--    Strictly per-member: one member must never see another's list, including
--    the private `notes` column.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,                          -- uuid, NOT a sequential integer
  team_member_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL CHECK (email = lower(email)),
  company TEXT,
  phone TEXT,
  notes TEXT,                                   -- member's private notes; never shown to the client

  -- Denormalised counters for the list screen. payment_requests stays the
  -- source of truth; these are advisory and rebuildable.
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  paid_count INTEGER NOT NULL DEFAULT 0 CHECK (paid_count >= 0),
  total_paid_pence INTEGER NOT NULL DEFAULT 0 CHECK (total_paid_pence >= 0),
  last_request_at TEXT,
  last_paid_at TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- RESTRICT, not CASCADE: deleting a member must fail loudly while they still
  -- have an address book, rather than quietly destroying the counterparty
  -- records that sit behind financial rows.
  FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE RESTRICT
);

-- The same client email may exist under two members; never twice under one.
-- This is also the upsert key for "create or reuse this client".
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_member_email  ON clients(team_member_id, email);
CREATE INDEX IF NOT EXISTS        idx_clients_member_recent ON clients(team_member_id, last_request_at DESC);
-- Parent key for the COMPOSITE foreign key from payment_requests. This is what
-- makes cross-member linkage impossible at the storage layer, instead of
-- dependent on every handler remembering `AND team_member_id = ?`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_id_member     ON clients(id, team_member_id);


-- ---------------------------------------------------------------------------
-- 4. payment_requests — the core row. One request = one intended charge.
--
--    STATUS MACHINE (every legal transition; nothing else is permitted):
--
--      draft      -> scheduled | sending | cancelling | cancelled
--      scheduled  -> sending (scheduler claim) | draft (unschedule) | cancelling
--      sending    -> sent | resume_status (transient failure) | failed (exhausted)
--      sent       -> processing | paid | expired | cancelling | sending (re-send)
--      processing -> paid | sent (async failure) | expired
--      cancelling -> cancelled | sent (abort: the session could not be expired)
--      failed     -> scheduled | draft | cancelling | cancelled
--      paid       -> refunded (a partial refund only moves refunded_pence)
--      cancelled | expired | refunded -> terminal
--
--    'viewed' is deliberately NOT a status: a viewed request is still awaiting
--    payment, and making it one would force every payable query to say
--    IN ('sent','viewed') — one missed site and a live pay link goes dead.
--    Views live on viewed_at / last_viewed_at / view_count and in the event log.
--
--    'sending' is the scheduler's claim state and is ALSO passed through by a
--    manual re-send, which is why resume_status exists: a re-send that dies must
--    return the row to 'sent' (link stays live), not to 'scheduled' (link dies,
--    and then the client is emailed a second time).
--
--    'processing' exists for delayed payment methods. checkout.session.completed
--    with payment_status='unpaid' leaves a session that is COMPLETE — Stripe will
--    never emit checkout.session.expired for it — so without this state the row
--    looks re-payable once the cached URL ages out and the client can be charged
--    twice.
--
--    'cancelling' exists because a cancel must expire the Stripe session BEFORE
--    the row stops being payable; otherwise the client pays a link we have
--    already written off and nothing records it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY,                          -- uuid, minted before insert (as orders.id)
  public_token TEXT NOT NULL UNIQUE,            -- 32 hex, HMAC of the id — the /pay/<token> link
  team_member_id TEXT NOT NULL,
  client_id TEXT,                               -- address-book link; detachable
  parent_request_id TEXT,                       -- set when this is a repeat of an earlier request

  -- Client details are SNAPSHOT, not read through client_id: a financial record
  -- must not change because someone edited the address book afterwards.
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL CHECK (client_email = lower(client_email)),

  -- What the client sees on /pay/<token>.
  tour_name TEXT NOT NULL,
  tour_date TEXT CHECK (tour_date IS NULL OR tour_date LIKE '____-__-__'),   -- 'YYYY-MM-DD'
  tour_time TEXT CHECK (tour_time IS NULL OR tour_time LIKE '__:__'),        -- 'HH:MM'
  tour_details TEXT,
  reference TEXT,                               -- the member's own booking reference

  currency TEXT NOT NULL DEFAULT 'gbp' CHECK (currency = lower(currency)),
  amount_pence INTEGER NOT NULL CHECK (amount_pence >= 30),  -- Stripe's GBP minimum

  -- FEE RESOLUTION: request override -> member -> platform default.
  -- fee_bps_override is ADMIN-ONLY (20% included by default, overridable by
  -- admin only, per member and per request).
  -- fee_bps / fee_pence / fee_source / fee_frozen_at are written ONCE, at send
  -- time, and are immutable thereafter — enforced by trg_pr_frozen_immutable,
  -- not by convention.
  fee_bps_override INTEGER CHECK (fee_bps_override IS NULL OR fee_bps_override BETWEEN 0 AND 10000),
  fee_bps INTEGER CHECK (fee_bps IS NULL OR fee_bps BETWEEN 0 AND 10000),
  fee_pence INTEGER CHECK (fee_pence IS NULL OR (fee_pence >= 0 AND fee_pence <= amount_pence)),
  fee_source TEXT CHECK (fee_source IS NULL OR fee_source IN ('request', 'member', 'platform')),
  fee_frozen_at TEXT CHECK (fee_frozen_at IS NULL OR fee_frozen_at LIKE '____-__-__ __:__:__'),

  -- Frozen at the same instant, and for the same reason, as the fee.
  terms_snapshot TEXT,                          -- the terms exactly as the client received them
  stripe_account_id TEXT,                       -- the acct_ this charge lands on (snapshot, not a join)
  member_display_name TEXT,                     -- trading name on the pay page and the email

  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'scheduled', 'sending', 'sent', 'processing', 'paid',
    'refunded', 'cancelling', 'cancelled', 'expired', 'failed'
  )),

  -- ---------------------------------------------------------------- scheduling
  send_rule TEXT NOT NULL DEFAULT 'now'
    CHECK (send_rule IN ('now', 'at', 'days_before_event')),
  send_rule_days INTEGER CHECK (send_rule_days IS NULL OR send_rule_days >= 0),

  -- send_at MUST be SQLite's own format. The LIKE guard is load-bearing, not
  -- cosmetic: '2026-08-12T09:00:00.000Z' — the obvious JS toISOString() default
  -- — compares ABOVE datetime('now') forever ('T' = 0x54 sorts above ' ' = 0x20),
  -- so the row would sit in 'scheduled' and never send, with no error anywhere
  -- to notice. Write it with strftime('%Y-%m-%d %H:%M:%S', ?) so a bad value is
  -- an immediate write error instead of a permanently invisible row.
  send_at TEXT CHECK (send_at IS NULL OR send_at LIKE '____-__-__ __:__:__'),

  -- Scheduler bookkeeping.
  send_attempts INTEGER NOT NULL DEFAULT 0 CHECK (send_attempts >= 0),
  max_send_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_send_attempts > 0),
  claim_id TEXT,                                -- uuid of the run holding this row in 'sending'
  claimed_at TEXT CHECK (claimed_at IS NULL OR claimed_at LIKE '____-__-__ __:__:__'),
  -- The status to restore when a claim fails or is reaped. Captured by the claim
  -- itself (SET resume_status = status), because a hard-coded return to
  -- 'scheduled' kills a live pay link on a failed re-send and then re-sends it.
  resume_status TEXT CHECK (resume_status IS NULL
                            OR resume_status IN ('draft', 'scheduled', 'sent')),
  last_send_error TEXT,
  sent_at TEXT CHECK (sent_at IS NULL OR sent_at LIKE '____-__-__ __:__:__'),

  -- Send-side idempotency, mirroring paid_email_sent. The dangerous window is:
  -- Resend accepts the mail, then the status write is lost — without this flag
  -- the reaper re-queues and the client receives a second payment request.
  -- Key Resend's Idempotency-Key on (id, reminder_count), NEVER on send_attempts:
  -- the claim increments send_attempts, so a retry would compute a different key
  -- and Resend would not dedupe.
  send_email_sent INTEGER NOT NULL DEFAULT 0 CHECK (send_email_sent IN (0, 1)),
  send_message_id TEXT,

  expires_at TEXT CHECK (expires_at IS NULL OR expires_at LIKE '____-__-__ __:__:__'),
  reminder_count INTEGER NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  last_reminder_at TEXT,

  viewed_at TEXT,                               -- first open
  last_viewed_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),

  -- ------------------------------------------------------------------- Stripe
  -- Single-flight lock for Checkout Session creation. Two tabs (or a double-tap
  -- on mobile) both read a row with no live session, both POST to Stripe, and
  -- the second UPDATE overwrites the first id — leaving a fully payable orphan
  -- session that no lookup can attribute. The lock is claimed with a conditional
  -- UPDATE BEFORE the Stripe call; only the winner mints.
  checkout_lock_id TEXT,
  checkout_lock_at TEXT CHECK (checkout_lock_at IS NULL
                               OR checkout_lock_at LIKE '____-__-__ __:__:__'),

  -- The CURRENT session, cached so an ordinary page view costs no Stripe call.
  -- It is a cache, not the record: every session ever minted lives in
  -- payment_request_sessions, and the webhook resolves through that table.
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_checkout_url TEXT,
  stripe_checkout_expires_at TEXT CHECK (stripe_checkout_expires_at IS NULL
                                         OR stripe_checkout_expires_at LIKE '____-__-__ __:__:__'),

  stripe_payment_intent TEXT,
  stripe_charge_id TEXT,
  stripe_application_fee_id TEXT,
  amount_paid_pence INTEGER CHECK (amount_paid_pence IS NULL OR amount_paid_pence >= 0),
  fee_collected_pence INTEGER CHECK (fee_collected_pence IS NULL OR fee_collected_pence >= 0),
  paid_at TEXT CHECK (paid_at IS NULL OR paid_at LIKE '____-__-__ __:__:__'),
  paid_email_sent INTEGER NOT NULL DEFAULT 0 CHECK (paid_email_sent IN (0, 1)),
  member_notified_at TEXT,                      -- internal heads-up; never gates the client receipt

  -- A payment that landed while the row was already expired or cancelled — the
  -- client completing 3-D Secure as the expiry sweep runs. The mark-paid guard
  -- must accept it (that money is real and sitting on the connected account);
  -- these two columns make it visible for triage instead of silently dropped.
  unexpected_payment INTEGER NOT NULL DEFAULT 0 CHECK (unexpected_payment IN (0, 1)),
  status_before_payment TEXT,

  -- Refund totals, maintained from payment_request_refunds by conditional
  -- UPDATE. fee_refunded_pence exists because a direct-charge refund WITHOUT
  -- refund_application_fee=true returns 100% to the client out of the member's
  -- balance while the platform keeps its 20% — the member funds our fee on a
  -- booking that generated no revenue.
  refunded_pence INTEGER NOT NULL DEFAULT 0 CHECK (refunded_pence >= 0),
  fee_refunded_pence INTEGER NOT NULL DEFAULT 0 CHECK (fee_refunded_pence >= 0),
  stripe_application_fee_refund_id TEXT,
  refunded_at TEXT,

  cancelled_at TEXT,
  cancel_reason TEXT,

  created_by TEXT,                              -- 'team:<uuid>' or 'admin:<email>'
  is_test INTEGER NOT NULL DEFAULT 0 CHECK (is_test IN (0, 1)),  -- mirrors orders.is_demo
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    CHECK (updated_at LIKE '____-__-__ __:__:__'),

  -- ------------------------------------------------------------ row invariants
  -- Once a request has reached the client it MUST carry its frozen terms.
  -- 'sending' is exempt because the claim flips the status first, then freezes,
  -- then sends. 'cancelling'/'cancelled'/'failed'/'draft'/'scheduled' are exempt
  -- because a request can die before it was ever sent.
  CHECK (status NOT IN ('sent', 'processing', 'paid', 'refunded', 'expired')
         OR (fee_bps IS NOT NULL AND fee_pence IS NOT NULL
             AND fee_source IS NOT NULL AND stripe_account_id IS NOT NULL
             AND fee_frozen_at IS NOT NULL)),

  -- The freeze is all-or-nothing: a half-frozen row would let the checkout read
  -- a fee that was never agreed.
  CHECK (fee_frozen_at IS NULL
         OR (fee_bps IS NOT NULL AND fee_pence IS NOT NULL
             AND fee_source IS NOT NULL AND stripe_account_id IS NOT NULL)),

  -- A 'scheduled' row with no send_at is a black hole: it matches no due query
  -- and no failure report, and the client waits forever.
  CHECK (status <> 'scheduled' OR send_at IS NOT NULL),

  -- A claim without a claim id cannot be released by its owner, nor told apart
  -- from a stale one by the reaper.
  CHECK (status <> 'sending' OR claim_id IS NOT NULL),

  -- Refunds can never exceed what was actually taken.
  CHECK (refunded_pence <= COALESCE(amount_paid_pence, amount_pence)),
  CHECK (fee_refunded_pence <= COALESCE(fee_collected_pence, fee_pence, 0)),

  FOREIGN KEY (team_member_id) REFERENCES team_members(id) ON DELETE RESTRICT,

  -- COMPOSITE ownership keys. A single-column FK proves the row exists; it does
  -- NOT prove it belongs to this member, and clients.id used to be a sequential
  -- integer anyone could walk. With these, a request can only ever point at a
  -- client and a parent belonging to the SAME member — so a handler that forgets
  -- `AND team_member_id = ?` fails with a constraint error instead of quietly
  -- copying another member's client details and pricing into a new draft.
  -- ON DELETE NO ACTION, never SET NULL: SQLite would try to null team_member_id
  -- as well, which is NOT NULL, and the delete would abort. Detach in app code:
  --   UPDATE payment_requests SET client_id = NULL
  --    WHERE client_id = ?1 AND team_member_id = ?2;
  FOREIGN KEY (client_id, team_member_id)
    REFERENCES clients(id, team_member_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  FOREIGN KEY (parent_request_id, team_member_id)
    REFERENCES payment_requests(id, team_member_id) ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- Team dashboard: "my requests, newest first".
CREATE INDEX IF NOT EXISTS idx_pr_member_created ON payment_requests(team_member_id, created_at DESC);
-- The same, filtered by tab (Scheduled / Awaiting payment / Paid).
CREATE INDEX IF NOT EXISTS idx_pr_member_status  ON payment_requests(team_member_id, status, created_at DESC);
-- Repeat-request history for one client, and the "send again" prefill.
CREATE INDEX IF NOT EXISTS idx_pr_client         ON payment_requests(client_id, created_at DESC);
-- Children of a request (the repeat chain).
CREATE INDEX IF NOT EXISTS idx_pr_parent         ON payment_requests(parent_request_id)
  WHERE parent_request_id IS NOT NULL;
-- Parent key for the self-referential composite FK above; also what makes an
-- ownership-scoped point read a single index seek.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_id_member ON payment_requests(id, team_member_id);

-- Scheduler: due sends. Partial, so the index stays tiny however many thousands
-- of paid rows accumulate.
CREATE INDEX IF NOT EXISTS idx_pr_due     ON payment_requests(send_at)   WHERE status = 'scheduled';
-- Scheduler: the reaper. NOTE the predicate carries NO send_attempts filter — a
-- row whose FINAL attempt died mid-flight already has
-- send_attempts = max_send_attempts, and a reaper filtered on
-- `send_attempts < max_send_attempts` would skip it forever, stranding it in
-- 'sending', which is not a dashboard tab and not a failure report. The reaper
-- statement (helper C) branches to 'failed' instead of excluding the row.
CREATE INDEX IF NOT EXISTS idx_pr_claimed ON payment_requests(claimed_at) WHERE status = 'sending';
-- Expiry sweep, and the settlement reconciliation sweep (rows payable for a
-- while that may have been paid without the webhook landing — the backstop that
-- stops a misconfigured Connect endpoint from becoming a second charge 23 hours
-- later). Both are leading-column composites rather than partial indexes on
-- expires_at / updated_at alone: a partial index whose WHERE says
-- `status IN ('sent','processing')` is only usable if the planner can PROVE the
-- query's predicate implies it, and it declines to when the query says
-- status = 'sent'. Verified with EXPLAIN QUERY PLAN — these are chosen, the
-- partial forms were not.
CREATE INDEX IF NOT EXISTS idx_pr_expiring  ON payment_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_pr_reconcile ON payment_requests(status, updated_at);
-- Receipt backstop: paid but never emailed, whichever path marked it paid.
-- Partial on the literal term the query actually carries (paid_email_sent = 0),
-- so the implication is trivial and the index stays tiny.
CREATE INDEX IF NOT EXISTS idx_pr_receipt_pending ON payment_requests(status, paid_at)
  WHERE paid_email_sent = 0;
-- Stuck two-phase cancel (the session expire at Stripe failed part-way).
CREATE INDEX IF NOT EXISTS idx_pr_cancelling ON payment_requests(updated_at) WHERE status = 'cancelling';

-- Admin oversight across the whole team.
CREATE INDEX IF NOT EXISTS idx_pr_status_created ON payment_requests(status, created_at DESC);
-- Per-connected-account reporting, reconciliation, and the deauthorization
-- sweep ("which of this account's requests are still live?").
CREATE INDEX IF NOT EXISTS idx_pr_account_status ON payment_requests(stripe_account_id, status);
-- Connect webhook fallbacks for events carrying a PaymentIntent or a Charge
-- rather than a session (payment_intent.succeeded, charge.refunded, disputes).
CREATE INDEX IF NOT EXISTS idx_pr_payment_intent ON payment_requests(stripe_payment_intent)
  WHERE stripe_payment_intent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pr_charge ON payment_requests(stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;
-- Reconciliation: the platform kept a fee it never earned.
CREATE INDEX IF NOT EXISTS idx_pr_fee_unreversed ON payment_requests(refunded_at)
  WHERE refunded_pence > 0 AND fee_refunded_pence = 0;
-- public_token and stripe_checkout_session_id are covered by their UNIQUE
-- constraints:  SELECT … WHERE public_token = ?   (the /pay/<token> page)


-- ---------------------------------------------------------------------------
-- 5. payment_request_sessions — EVERY Checkout Session ever minted for a
--    request, keyed by Stripe's own id.
--
--    This table is the fix for a proven double-charge bug. A single
--    stripe_checkout_session_id column can only remember the LAST session, and
--    UNIQUE on it prevents storing the same id twice, not two different
--    sessions. The moment a second session exists — two tabs, a superseded
--    session after an expiry, a re-mint after a lock timeout — the webhook for
--    the forgotten one resolves to nothing, and that charge is real money with
--    no receipt, no row and no reconciliation.
--
--    With this table ANY session id resolves to exactly one request, forever.
--    Amount, currency and fee are snapshotted PER SESSION so a charge is proved
--    against the figures its own session was created with, and `nonce` makes the
--    metadata fallback unforgeable: these are Standard connected accounts, so
--    the member holds their own Stripe key and can create a session on their own
--    account carrying our client_reference_id and NO application_fee_amount.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_request_sessions (
  id TEXT PRIMARY KEY,                          -- cs_… Stripe's own id: unforgeable, so no uuid needed
  payment_request_id TEXT NOT NULL,
  stripe_account_id TEXT NOT NULL,              -- the acct_ the session was created on

  -- 128 bits we minted, echoed back in session metadata. A connected account
  -- cannot guess it, so a session carrying the right nonce is provably ours.
  nonce TEXT NOT NULL,

  -- What this session was created to charge. Settlement compares the webhook's
  -- amount_total / currency / application_fee_amount against THESE, not against
  -- the request's current values.
  amount_pence INTEGER NOT NULL CHECK (amount_pence >= 30),
  currency TEXT NOT NULL CHECK (currency = lower(currency)),
  fee_pence INTEGER NOT NULL CHECK (fee_pence >= 0 AND fee_pence <= amount_pence),

  -- 'open'       — payable
  -- 'processing' — completed with a delayed payment method, not yet paid
  -- 'complete'   — paid; the money write has been done
  -- 'expired'    — expired at Stripe (by us, or by the 24h ceiling)
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'processing', 'complete', 'expired')),

  checkout_url TEXT,
  expires_at TEXT CHECK (expires_at IS NULL OR expires_at LIKE '____-__-__ __:__:__'),
  completed_at TEXT,
  stripe_payment_intent TEXT,
  created_by_lock TEXT,                         -- the checkout_lock_id that won the right to mint
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- RESTRICT: a request with sessions is a request that may have taken money.
  FOREIGN KEY (payment_request_id) REFERENCES payment_requests(id) ON DELETE RESTRICT
);

-- Webhook: session id -> request. The primary key covers it.
CREATE INDEX IF NOT EXISTS idx_prs_request ON payment_request_sessions(payment_request_id, created_at DESC);
-- Guard rail: at most one payable session per request at a time. A UNIQUE
-- partial index turns "mint a second live session" from a race into a constraint
-- error, backing up the checkout lock rather than depending on it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_prs_one_open ON payment_request_sessions(payment_request_id)
  WHERE status IN ('open', 'processing');
-- Sweep: sessions to expire at Stripe (on cancel, on amount change, on stall).
CREATE INDEX IF NOT EXISTS idx_prs_open_expiry ON payment_request_sessions(expires_at) WHERE status = 'open';
-- Fallback resolution when the event carries only a PaymentIntent.
CREATE INDEX IF NOT EXISTS idx_prs_payment_intent ON payment_request_sessions(stripe_payment_intent)
  WHERE stripe_payment_intent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_prs_account ON payment_request_sessions(stripe_account_id, status);


-- ---------------------------------------------------------------------------
-- 6. payment_request_refunds — one row per Stripe refund, mirroring the
--    existing `refunds` table for vouchers.
--
--    UNIQUE on stripe_refund_id is the whole point: the admin-initiated path and
--    the charge.refunded webhook both want to record the same refund, and
--    charge.amount_refunded is a RUNNING TOTAL, so adding it to refunded_pence
--    double-counts. With a per-refund row both paths converge on one truth, and
--    a double-click cannot refund twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_request_refunds (
  id TEXT PRIMARY KEY,                          -- uuid
  payment_request_id TEXT NOT NULL,
  stripe_refund_id TEXT UNIQUE,                 -- re_…; UNIQUE is the dedupe key
  stripe_account_id TEXT NOT NULL,              -- refunds live on the connected account
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  -- The platform fee handed back with this refund. Stripe reverses the
  -- application fee pro rata when refund_application_fee=true.
  fee_reversed_pence INTEGER NOT NULL DEFAULT 0 CHECK (fee_reversed_pence >= 0),
  stripe_application_fee_refund_id TEXT,
  reason TEXT CHECK (reason IS NULL
                     OR reason IN ('duplicate', 'fraudulent', 'requested_by_customer')),
  note TEXT,
  refunded_by TEXT,                             -- 'admin:<email>' | 'system' | 'stripe'
  status TEXT NOT NULL DEFAULT 'succeeded'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (fee_reversed_pence <= amount_pence),
  FOREIGN KEY (payment_request_id) REFERENCES payment_requests(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_prr_request ON payment_request_refunds(payment_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prr_account ON payment_request_refunds(stripe_account_id, created_at DESC);
-- A refund we recorded but never confirmed.
CREATE INDEX IF NOT EXISTS idx_prr_pending ON payment_request_refunds(created_at) WHERE status = 'pending';


-- ---------------------------------------------------------------------------
-- 7. stripe_connect_events — webhook dedupe, as a COMPLETION marker.
--
--    The dedupe row must NEVER be a pre-claim. "INSERT OR IGNORE first, and
--    0 rows changed means already processed" is two D1 statements with no
--    transaction: insert the marker, then die before the money write, and every
--    Stripe retry for the next three days sees the marker, returns 200, and does
--    nothing. The payment then exists on the connected account and nowhere else.
--
--    So: insert with processed_at NULL, do the work (every downstream write is
--    status-guarded and therefore replay-safe), then set processed_at LAST.
--    Skip ONLY when processed_at IS NOT NULL.
--
--    Separate from payment_request_events because payment_request_id there is
--    NOT NULL with an FK: a Standard connected account generates plenty of
--    events from its own unrelated business, and an event we cannot attribute
--    must still be recordable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stripe_connect_events (
  id TEXT PRIMARY KEY,                          -- evt_…, Stripe's own id
  stripe_account_id TEXT,                       -- event.account; NULL for a platform event
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL DEFAULT 0 CHECK (livemode IN (0, 1)),
  payment_request_id TEXT,                      -- filled in once resolved; may stay NULL
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set at the START of an attempt so a crashed attempt is visibly in flight and
  -- re-claimable after a grace period. It is NOT a dedupe key.
  claimed_at TEXT CHECK (claimed_at IS NULL OR claimed_at LIKE '____-__-__ __:__:__'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- The ONLY value that means "do not run this again".
  processed_at TEXT CHECK (processed_at IS NULL OR processed_at LIKE '____-__-__ __:__:__'),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (
    'settled', 'ignored', 'duplicate', 'rejected', 'unmatched', 'error'
  )),
  last_error TEXT,
  payload_summary TEXT,                         -- small JSON: ids and amounts, never the whole event
  FOREIGN KEY (payment_request_id) REFERENCES payment_requests(id) ON DELETE NO ACTION
);

-- The dedupe read is WHERE id = ? (the primary key).
-- Alert sweep: an event received but never completed is a payment in limbo.
CREATE INDEX IF NOT EXISTS idx_sce_unprocessed ON stripe_connect_events(received_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sce_request     ON stripe_connect_events(payment_request_id, received_at DESC)
  WHERE payment_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sce_account     ON stripe_connect_events(stripe_account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_sce_outcome     ON stripe_connect_events(outcome, received_at DESC);


-- ---------------------------------------------------------------------------
-- 8. unmatched_payments — real money that resolves to no request.
--
--    Reachable without any attack: an event for a superseded session, a charge
--    on a request that was cancelled or expired while the client sat on the
--    Stripe page, or an account/amount/fee mismatch that settlement refuses.
--    Every one of those paths would otherwise be a console.error and a 200.
--    A row here is the thing an operator can act on — usually by refunding.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unmatched_payments (
  id TEXT PRIMARY KEY,                          -- uuid
  stripe_account_id TEXT NOT NULL,
  stripe_event_id TEXT,
  stripe_session_id TEXT,
  stripe_payment_intent TEXT,
  stripe_charge_id TEXT,
  client_reference_id TEXT,                     -- what the session CLAIMED to be; advisory only
  amount_pence INTEGER CHECK (amount_pence IS NULL OR amount_pence >= 0),
  currency TEXT,
  application_fee_pence INTEGER,
  reason TEXT NOT NULL,                         -- 'unknown session' | 'account mismatch' | 'fee mismatch' | …
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'refunded', 'ignored')),
  resolved_at TEXT,
  resolved_by TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS        idx_up_open    ON unmatched_payments(created_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS        idx_up_account ON unmatched_payments(stripe_account_id, created_at DESC);
-- One row per event, so a Stripe retry does not pile up duplicates for ops.
CREATE UNIQUE INDEX IF NOT EXISTS idx_up_event   ON unmatched_payments(stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;


-- ---------------------------------------------------------------------------
-- 9. payment_request_events — append-only audit trail for one request.
--
--    Ordering is (created_at, rowid): created_at has one-second resolution and
--    SQLite's implicit rowid breaks ties in insertion order. The primary key is
--    a uuid like every other entity here, so no id in this schema is guessable
--    or enumerable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_request_events (
  id TEXT PRIMARY KEY,                          -- uuid
  payment_request_id TEXT NOT NULL,
  team_member_id TEXT NOT NULL,                 -- denormalised so the log is scopable without a join
  type TEXT NOT NULL CHECK (type IN (
    'created', 'updated', 'scheduled', 'unscheduled',
    'send_claimed', 'send_released', 'sent', 'send_failed', 'reminder_sent',
    'viewed', 'checkout_created', 'checkout_expired',
    'paid', 'payment_processing', 'payment_failed', 'late_payment',
    'cancelled', 'expired', 'refunded', 'fee_reversed', 'fee_overridden',
    'account_changed', 'alert', 'note'
  )),
  detail TEXT,                                  -- one human-readable line for the timeline
  data TEXT,                                    -- optional JSON (amounts, Stripe ids, errors)
  actor TEXT,                                   -- 'team:<uuid>' | 'admin:<email>' | 'client' | 'system' | 'stripe'
  ip TEXT,                                      -- client-side events only (viewed, checkout_created)
  stripe_event_id TEXT,                         -- evt_… when this row came from a webhook
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (payment_request_id) REFERENCES payment_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (team_member_id)     REFERENCES team_members(id)     ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_pre_request      ON payment_request_events(payment_request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pre_member       ON payment_request_events(team_member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pre_type_created ON payment_request_events(type, created_at DESC);
-- Alert triage across the whole platform.
CREATE INDEX IF NOT EXISTS idx_pre_alerts ON payment_request_events(created_at DESC)
  WHERE type IN ('alert', 'payment_failed', 'send_failed', 'late_payment');


-- ---------------------------------------------------------------------------
-- 10. login_attempts — throttling keyed PRIMARILY by IP.
--
--     A lockout keyed only on the account is a remote denial of service on the
--     money path: the member's login address is a work email, so ten wrong
--     passwords every fifteen minutes locks them out permanently, from anywhere,
--     with no recovery except an admin password reset. The per-IP counter here
--     is the primary control; team_members.locked_until is a slow secondary, and
--     the password is verified even while locked so a correct one gets through
--     and clears both.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,                          -- 'ip:<addr>' or 'member:<uuid>' — the throttle key
  scope TEXT NOT NULL CHECK (scope IN ('ip', 'member')),
  fail_count INTEGER NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
  window_started_at INTEGER NOT NULL,           -- unix seconds
  last_failed_at INTEGER,
  locked_until INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_locked ON login_attempts(locked_until)
  WHERE locked_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_login_attempts_window ON login_attempts(window_started_at);


-- ---------------------------------------------------------------------------
-- 11. email_suppressions — belt and braces for "no mail to Alehunters during
--     the build". The send path checks this table before EVERY send, so the
--     guarantee survives a copy-pasted handler or a missed code path. Removing
--     the seeded row must be a deliberate act at go-live.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_suppressions (
  email TEXT PRIMARY KEY CHECK (email = lower(email)),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OR IGNORE so re-applying cannot fail here, and cannot overwrite a reason an
-- operator has edited. Removing this row is a deliberate act, not a side effect.
INSERT OR IGNORE INTO email_suppressions (email, reason) VALUES
  ('hello@alehunters.co.uk',
   'Build guard: no contact with the first connected account until go-live is agreed.');


-- ===========================================================================
-- TRIGGERS — the guards a CHECK constraint cannot express.
--
-- A CHECK sees only NEW. It can say "a sent row must have a fee", but it cannot
-- say "the fee must be the SAME fee", because it cannot see OLD. Every
-- immutability claim in this schema therefore lives in a trigger.
--
-- AFTER UPDATE, not BEFORE: RAISE(ABORT) rolls the statement back either way,
-- and AFTER guarantees the row is fully formed (all CHECKs already passed)
-- before the comparison, so the caller sees the specific message below rather
-- than an unrelated constraint that happened to fire first.
--
-- `IS NOT` rather than `<>` because it is null-safe: `NULL <> 5` evaluates to
-- NULL, which is falsey, so a `<>` comparison would silently permit exactly the
-- transition that matters most — writing a value over a NULL.
-- ===========================================================================

-- 1. Frozen terms. Once fee_frozen_at is set, the commercial terms are fixed:
--    the client holds an email and a pay page stating them, and Stripe has been
--    told (or is about to be told) a matching application_fee_amount.
--
--    Without this, the table CHECK is satisfied by ANY non-null value, including
--    a rewritten one, and the obvious PATCH endpoint — body keys mapped to a SET
--    clause — becomes the fee-theft path: send a £2,000 request, then
--    UPDATE fee_pence = 0 before the client clicks. Or repoint stripe_account_id
--    so the charge lands on a different legal entity. Or halve amount_pence
--    while the cached Checkout URL still charges the original figure.
--
--    The remedy for a genuine mistake is not an UPDATE: cancel (expiring the
--    Stripe session first) and re-issue with parent_request_id set.
CREATE TRIGGER IF NOT EXISTS trg_pr_frozen_immutable
AFTER UPDATE ON payment_requests
FOR EACH ROW
WHEN OLD.fee_frozen_at IS NOT NULL
 AND (   NEW.amount_pence        IS NOT OLD.amount_pence
      OR NEW.currency            IS NOT OLD.currency
      OR NEW.fee_bps             IS NOT OLD.fee_bps
      OR NEW.fee_pence           IS NOT OLD.fee_pence
      OR NEW.fee_source          IS NOT OLD.fee_source
      OR NEW.fee_bps_override    IS NOT OLD.fee_bps_override
      OR NEW.fee_frozen_at       IS NOT OLD.fee_frozen_at
      OR NEW.stripe_account_id   IS NOT OLD.stripe_account_id
      OR NEW.terms_snapshot      IS NOT OLD.terms_snapshot
      OR NEW.member_display_name IS NOT OLD.member_display_name)
BEGIN
  SELECT RAISE(ABORT,
    'payment_requests: terms are frozen (amount/currency/fee/account/terms) - cancel and re-issue');
END;

-- 2. Identity. public_token is the bearer credential for the pay page and
--    team_member_id is the entire ownership model; neither may EVER move, at any
--    status. Re-pointing team_member_id would hand a request — and its money —
--    to another member, and would also defeat the composite foreign keys.
CREATE TRIGGER IF NOT EXISTS trg_pr_identity_immutable
AFTER UPDATE ON payment_requests
FOR EACH ROW
WHEN NEW.id             IS NOT OLD.id
  OR NEW.public_token   IS NOT OLD.public_token
  OR NEW.team_member_id IS NOT OLD.team_member_id
  OR NEW.created_at     IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT,
    'payment_requests: id, public_token, team_member_id and created_at are immutable');
END;

-- 3. Terminal statuses. A webhook retry arriving after a refund must not rewrite
--    the row back to 'paid' — money that has been returned would reappear as
--    revenue and refunded_pence would contradict the status. Settlement is still
--    free to record a LATE payment on an expired or cancelled row (that money is
--    real and must land somewhere), which is why those two are not terminal here.
CREATE TRIGGER IF NOT EXISTS trg_pr_terminal_status
AFTER UPDATE OF status ON payment_requests
FOR EACH ROW
WHEN (OLD.status = 'refunded' AND NEW.status <> 'refunded')
  OR (OLD.status = 'paid' AND NEW.status NOT IN ('paid', 'refunded'))
BEGIN
  SELECT RAISE(ABORT, 'payment_requests: paid and refunded are terminal');
END;

-- 4. A session row records what Stripe was actually asked to charge. If the
--    amount, fee, account or nonce could be edited afterwards, the settlement
--    comparison would be checking the webhook against a value someone had just
--    written to make it match.
CREATE TRIGGER IF NOT EXISTS trg_prs_immutable
AFTER UPDATE ON payment_request_sessions
FOR EACH ROW
WHEN NEW.id                 IS NOT OLD.id
  OR NEW.payment_request_id IS NOT OLD.payment_request_id
  OR NEW.stripe_account_id  IS NOT OLD.stripe_account_id
  OR NEW.nonce              IS NOT OLD.nonce
  OR NEW.amount_pence       IS NOT OLD.amount_pence
  OR NEW.currency           IS NOT OLD.currency
  OR NEW.fee_pence          IS NOT OLD.fee_pence
BEGIN
  SELECT RAISE(ABORT, 'payment_request_sessions: the charge terms of a session are immutable');
END;

-- 5. A refund row is history. Only its confirmation status may move.
CREATE TRIGGER IF NOT EXISTS trg_prr_immutable
AFTER UPDATE ON payment_request_refunds
FOR EACH ROW
WHEN NEW.payment_request_id IS NOT OLD.payment_request_id
  OR NEW.amount_pence       IS NOT OLD.amount_pence
  OR NEW.stripe_account_id  IS NOT OLD.stripe_account_id
  OR (OLD.stripe_refund_id IS NOT NULL AND NEW.stripe_refund_id IS NOT OLD.stripe_refund_id)
BEGIN
  SELECT RAISE(ABORT, 'payment_request_refunds: a recorded refund is immutable');
END;

-- 6. Webhook dedupe must stay a COMPLETION marker. Clearing processed_at would
--    re-open a settled event to replay; rewriting it would hide the first
--    completion. Written once, never touched again.
CREATE TRIGGER IF NOT EXISTS trg_sce_processed_once
AFTER UPDATE OF processed_at ON stripe_connect_events
FOR EACH ROW
WHEN OLD.processed_at IS NOT NULL AND NEW.processed_at IS NOT OLD.processed_at
BEGIN
  SELECT RAISE(ABORT, 'stripe_connect_events: processed_at is written once');
END;


-- ===========================================================================
-- Query-planner statistics.
--
-- Measured, not cargo-culted: with no sqlite_stat1 present the planner ignores
-- the partial indexes above and answers the due-sends query from
-- idx_pr_status_created plus a temp b-tree sort. One ANALYZE here (instant — the
-- tables are empty) makes it choose idx_pr_due / idx_pr_claimed / idx_pr_expiring,
-- and that choice holds as the table grows. Worth re-running occasionally:
--   npx wrangler d1 execute ukbrewerytours-vouchers --remote --command "ANALYZE"
-- ===========================================================================
ANALYZE;


-- ===========================================================================
-- SHARED SQL HELPERS
--
-- Not executed. Kept here so the schema documents its own access patterns, so
-- every index above has a named caller, and so the concurrency-critical
-- statements exist in exactly one authoritative place. Copy them verbatim.
-- ===========================================================================
--
-- ---------------------------------------------------------------------------
-- A. SCHEDULER — claim due sends
-- ---------------------------------------------------------------------------
-- One statement, therefore atomic. A second overlapping run finds the status
-- already flipped and matches zero rows. UPDATE…LIMIT is not compiled into D1,
-- hence the id IN (SELECT … LIMIT n) form. `resume_status = status` reads the
-- PRE-update value, which is what lets a failed re-send restore 'sent'.
-- Gate the whole sweep on platform_settings.send_enabled = 1 first.
--
--   UPDATE payment_requests
--      SET status        = 'sending',
--          resume_status = status,
--          claim_id      = ?1,                 -- uuid unique to this run
--          claimed_at    = datetime('now'),
--          send_attempts = send_attempts + 1,
--          updated_at    = datetime('now')
--    WHERE status = 'scheduled'
--      AND send_at IS NOT NULL
--      AND send_at <= datetime('now')
--      AND send_attempts < max_send_attempts
--      AND id IN (SELECT id FROM payment_requests
--                  WHERE status = 'scheduled'
--                    AND send_at IS NOT NULL
--                    AND send_at <= datetime('now')
--                  ORDER BY send_at LIMIT 25)
--   RETURNING *;
--   -- If RETURNING is unavailable:
--   --   SELECT * FROM payment_requests WHERE claim_id = ?1 AND status = 'sending';
--
-- ---------------------------------------------------------------------------
-- B. FREEZE THE TERMS (after the claim, before the email)
-- ---------------------------------------------------------------------------
-- Values from _lib/fees.js freezeTerms(). Guarded by claim_id so a stale worker
-- cannot freeze a row someone else now owns, and by fee_frozen_at IS NULL so it
-- can only ever happen once. Refuse to freeze at all unless the member is
-- sendable (helper H).
--
--   UPDATE payment_requests
--      SET fee_bps = ?3, fee_pence = ?4, fee_source = ?5,
--          stripe_account_id = ?6, member_display_name = ?7, terms_snapshot = ?8,
--          expires_at = strftime('%Y-%m-%d %H:%M:%S', ?9),
--          fee_frozen_at = datetime('now'), updated_at = datetime('now')
--    WHERE id = ?1 AND claim_id = ?2 AND status = 'sending' AND fee_frozen_at IS NULL;
--
-- ---------------------------------------------------------------------------
-- C. SEND SUCCEEDED / FAILED / REAPED
-- ---------------------------------------------------------------------------
--   -- Succeeded. send_email_sent and status move in ONE statement, so there is
--   -- no window where the mail is out but the row still looks unsent.
--   UPDATE payment_requests
--      SET status = 'sent', sent_at = datetime('now'),
--          send_email_sent = 1, send_message_id = ?3,
--          claim_id = NULL, claimed_at = NULL, resume_status = NULL,
--          last_send_error = NULL, updated_at = datetime('now')
--    WHERE id = ?1 AND status = 'sending' AND claim_id = ?2;
--
--   -- Failed: back to where it came from, with backoff, or give up.
--   UPDATE payment_requests
--      SET status = CASE WHEN send_attempts >= max_send_attempts
--                        THEN 'failed' ELSE COALESCE(resume_status, 'scheduled') END,
--          send_at = CASE WHEN send_attempts >= max_send_attempts THEN send_at
--                         WHEN COALESCE(resume_status, 'scheduled') = 'scheduled'
--                         THEN datetime('now', '+' || (15 * send_attempts) || ' minutes')
--                         ELSE send_at END,
--          claim_id = NULL, claimed_at = NULL, resume_status = NULL,
--          last_send_error = ?3, updated_at = datetime('now')
--    WHERE id = ?1 AND status = 'sending' AND claim_id = ?2;
--
--   -- REAPER, run on the same tick as the claim. NOTE: no send_attempts filter
--   -- in the predicate. The claim has ALREADY incremented the counter, so a row
--   -- whose final attempt died has send_attempts = max_send_attempts; a reaper
--   -- filtered on `send_attempts < max_send_attempts` would skip it forever and
--   -- leave it stranded in 'sending' — not a dashboard tab, not a failure
--   -- report, invisible until someone asks why a client never paid. The CASE
--   -- below is what recovers it, by moving it to 'failed' instead.
--   UPDATE payment_requests
--      SET status = CASE WHEN send_attempts >= max_send_attempts
--                        THEN 'failed' ELSE COALESCE(resume_status, 'scheduled') END,
--          send_at = CASE WHEN send_attempts >= max_send_attempts THEN send_at
--                         WHEN COALESCE(resume_status, 'scheduled') = 'scheduled'
--                         THEN datetime('now', '+5 minutes')
--                         ELSE send_at END,
--          claim_id = NULL, claimed_at = NULL, resume_status = NULL,
--          last_send_error = 'released after stalled send',
--          updated_at = datetime('now')
--    WHERE status = 'sending' AND claimed_at <= datetime('now', '-15 minutes');
--
-- ---------------------------------------------------------------------------
-- D. CHECKOUT — single-flight, then record the session
-- ---------------------------------------------------------------------------
--   -- 1. Win the right to mint. Only the winner calls Stripe.
--   UPDATE payment_requests
--      SET checkout_lock_id = ?2, checkout_lock_at = datetime('now'),
--          updated_at = datetime('now')
--    WHERE public_token = ?1
--      AND status = 'sent'
--      AND (checkout_lock_id IS NULL OR checkout_lock_at <= datetime('now', '-2 minutes'));
--   -- changes = 0 -> someone else is minting: re-read and reuse stripe_checkout_url.
--
--   -- 2. Record the session BEFORE handing out the URL. If this INSERT fails,
--   --    idx_prs_one_open has already prevented a second payable session.
--   INSERT INTO payment_request_sessions
--     (id, payment_request_id, stripe_account_id, nonce, amount_pence, currency,
--      fee_pence, status, checkout_url, expires_at, created_by_lock)
--   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8,
--           strftime('%Y-%m-%d %H:%M:%S', ?9), ?10);
--
--   UPDATE payment_requests
--      SET stripe_checkout_session_id = ?1, stripe_checkout_url = ?8,
--          stripe_checkout_expires_at = strftime('%Y-%m-%d %H:%M:%S', ?9),
--          checkout_lock_id = NULL, updated_at = datetime('now')
--    WHERE id = ?2 AND checkout_lock_id = ?10;
--
--   -- Stripe Idempotency-Key: 'pr-cs-' || <payment_request_id> || '-' || <checkout_lock_id>
--   -- Pin payment_method_types[0]=card: the methods offered otherwise come from
--   -- the CONNECTED account's dashboard, and a delayed method (Bacs, Klarna)
--   -- produces a completed-but-unpaid session we never asked for.
--
-- ---------------------------------------------------------------------------
-- E. WEBHOOK — dedupe, resolve, settle
-- ---------------------------------------------------------------------------
--   -- 1. Marker, NOT a claim.
--   INSERT INTO stripe_connect_events (id, stripe_account_id, type, livemode, attempts, claimed_at)
--   VALUES (?1, ?2, ?3, ?4, 1, datetime('now'))
--   ON CONFLICT(id) DO UPDATE
--        SET attempts = attempts + 1, claimed_at = datetime('now')
--      WHERE stripe_connect_events.processed_at IS NULL;
--   -- Then: SELECT processed_at FROM stripe_connect_events WHERE id = ?1;
--   --       processed_at IS NOT NULL  ->  already done: return 200 and stop.
--
--   -- 2. Resolve by an identifier the PLATFORM minted, scoped to the account the
--   --    event actually happened on. Never resolve from metadata alone: a
--   --    Standard connected account holds its own API key and can put our
--   --    client_reference_id on a session of its own with no application fee.
--   SELECT pr.*, s.amount_pence AS session_amount_pence, s.fee_pence AS session_fee_pence,
--          s.currency AS session_currency, s.nonce AS session_nonce
--     FROM payment_request_sessions s
--     JOIN payment_requests pr ON pr.id = s.payment_request_id
--    WHERE s.id = ?1 AND s.stripe_account_id = ?2;
--   -- PaymentIntent-only events: WHERE s.stripe_payment_intent = ?1 AND s.stripe_account_id = ?2
--   -- No row, or a nonce / amount / currency / application_fee mismatch:
--   --   INSERT INTO unmatched_payments (…, reason) VALUES (…, 'unknown session');
--   --   and alert. Never a silent 200.
--
--   -- 3. Money write. The guard is "not already settled", not "still sent": an
--   --    expiry sweep or a cancel can land while the client is completing 3-D
--   --    Secure, and that charge is real. unexpected_payment makes it visible
--   --    rather than dropping it.
--   UPDATE payment_requests
--      SET status = 'paid', paid_at = datetime('now'),
--          status_before_payment = status,
--          unexpected_payment = CASE WHEN status IN ('cancelled', 'expired', 'cancelling')
--                                    THEN 1 ELSE 0 END,
--          stripe_payment_intent = ?2, stripe_charge_id = ?3,
--          amount_paid_pence = ?4, fee_collected_pence = ?5,
--          stripe_application_fee_id = ?6, updated_at = datetime('now')
--    WHERE id = ?1 AND status NOT IN ('paid', 'refunded');
--   -- changes = 1 -> this caller made the transition.
--   -- changes = 0 -> re-read: already 'paid' is a replay (fine); anything else
--   --                is an alert, never a benign no-op.
--
--   UPDATE payment_request_sessions
--      SET status = 'complete', completed_at = datetime('now'), stripe_payment_intent = ?2
--    WHERE id = ?7 AND status <> 'complete';
--
--   -- 3b. Stripe ids on EVERY delivery, not only the winning one — otherwise a
--   --     receipt-email failure, or a redirect reconcile that won the race,
--   --     leaves the row permanently without a charge id and no refund or
--   --     dispute can ever be matched to it.
--   UPDATE payment_requests
--      SET stripe_payment_intent = COALESCE(stripe_payment_intent, ?2),
--          stripe_charge_id      = COALESCE(stripe_charge_id, ?3),
--          fee_collected_pence   = COALESCE(fee_collected_pence, ?5)
--    WHERE id = ?1 AND stripe_charge_id IS NULL;
--
--   -- 4. Receipt, claimed by compare-and-swap so exactly one path sends it —
--   --    webhook, redirect reconcile, or the sweep. Send ONLY when changes = 1.
--   UPDATE payment_requests SET paid_email_sent = 1
--    WHERE id = ?1 AND paid_email_sent = 0;
--
--   -- 5. Completion marker LAST.
--   UPDATE stripe_connect_events
--      SET processed_at = datetime('now'), outcome = ?2, payment_request_id = ?3
--    WHERE id = ?1 AND processed_at IS NULL;
--
-- ---------------------------------------------------------------------------
-- F. REFUNDS — record the refund, then move the totals
-- ---------------------------------------------------------------------------
--   -- Always call Stripe with refund_application_fee=true and the Stripe-Account
--   -- header, or the client is made whole out of the member's balance while the
--   -- platform keeps 20% it never earned.
--   -- Idempotency-Key: 'pr-refund-' || <id> || '-' || <refunded_pence before> || '-' || <amount>
--
--   INSERT OR IGNORE INTO payment_request_refunds
--     (id, payment_request_id, stripe_refund_id, stripe_account_id, amount_pence,
--      fee_reversed_pence, stripe_application_fee_refund_id, reason, refunded_by, status)
--   VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'succeeded');
--   -- changes = 0 -> this Stripe refund is already recorded; do NOT touch totals.
--
--   UPDATE payment_requests
--      SET refunded_pence     = refunded_pence + ?5,
--          fee_refunded_pence = fee_refunded_pence + ?6,
--          stripe_application_fee_refund_id = COALESCE(stripe_application_fee_refund_id, ?7),
--          refunded_at = datetime('now'),
--          status = CASE WHEN refunded_pence + ?5 >= COALESCE(amount_paid_pence, amount_pence)
--                        THEN 'refunded' ELSE status END,
--          updated_at = datetime('now')
--    WHERE id = ?2
--      AND refunded_pence = ?10                          -- compare-and-swap on what we read
--      AND refunded_pence + ?5 <= COALESCE(amount_paid_pence, amount_pence);
--
--   -- charge.refunded carries a RUNNING TOTAL (charge.amount_refunded). Never add
--   -- it. Reconcile to the absolute value instead, and only upward:
--   UPDATE payment_requests
--      SET refunded_pence = ?2,
--          status = CASE WHEN ?2 >= COALESCE(amount_paid_pence, amount_pence)
--                        THEN 'refunded' ELSE status END,
--          updated_at = datetime('now')
--    WHERE stripe_charge_id = ?1 AND stripe_account_id = ?3 AND refunded_pence < ?2;
--
-- ---------------------------------------------------------------------------
-- G. CANCEL — two phase, because a cancelled row with a live session is a
--    payment nobody will record
-- ---------------------------------------------------------------------------
--   UPDATE payment_requests SET status = 'cancelling', updated_at = datetime('now')
--    WHERE id = ?1 AND team_member_id = ?2
--      AND status IN ('draft', 'scheduled', 'sent', 'failed');
--   -- then POST /v1/checkout/sessions/{id}/expire with Stripe-Account for every
--   -- open session. A 'session already completed' error ABORTS the cancel:
--   --   UPDATE payment_requests SET status = 'sent' WHERE id = ?1 AND status = 'cancelling';
--   UPDATE payment_request_sessions SET status = 'expired'
--    WHERE payment_request_id = ?1 AND status = 'open';
--   UPDATE payment_requests
--      SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ?3,
--          stripe_checkout_url = NULL, stripe_checkout_session_id = NULL,
--          stripe_checkout_expires_at = NULL, updated_at = datetime('now')
--    WHERE id = ?1 AND status = 'cancelling';
--
--   -- The expiry sweep must refuse to expire a row with a live session:
--   UPDATE payment_requests SET status = 'expired', updated_at = datetime('now')
--    WHERE status = 'sent' AND expires_at IS NOT NULL AND expires_at <= datetime('now')
--      AND NOT EXISTS (SELECT 1 FROM payment_request_sessions s
--                       WHERE s.payment_request_id = payment_requests.id
--                         AND s.status IN ('open', 'processing'));
--
-- ---------------------------------------------------------------------------
-- H. GATES AND MONITORS
-- ---------------------------------------------------------------------------
--   -- Is this member sendable? Required before a claim, before freezeTerms(),
--   -- and before minting a Checkout Session. charges_enabled alone is not enough:
--   -- platform_payments can go inactive while charges still work, and only
--   -- application_fee_amount is refused.
--   SELECT 1 FROM team_members
--    WHERE id = ?1 AND active = 1
--      AND stripe_charges_enabled = 1
--      AND stripe_account_state = 'active'
--      AND stripe_platform_payments = 'active'
--      AND stripe_account_checked_at IS NOT NULL
--      AND stripe_account_checked_at > datetime('now', '-24 hours');
--   -- Stale -> re-fetch GET /v1/accounts/{id} rather than send blind.
--
--   -- The pay page and the checkout endpoint JOIN the member. The snapshot
--   -- account is used for SETTLING a session already minted, never for minting a
--   -- new one on a member who has been deactivated or has deauthorized us.
--   SELECT pr.*, tm.active, tm.stripe_charges_enabled, tm.stripe_account_state
--     FROM payment_requests pr JOIN team_members tm ON tm.id = pr.team_member_id
--    WHERE pr.public_token = ?1;
--
--   -- Deactivation is ONE batch, or a live session survives it:
--   --   UPDATE team_members SET active = 0, session_epoch = session_epoch + 1 WHERE id = ?1;
--   --   plus the cancel flow above for every request in ('draft','scheduled','sent').
--
--   -- MONITORS. A non-empty result is an alert, whatever the cause.
--   SELECT COUNT(*) FROM payment_requests
--    WHERE status = 'scheduled' AND send_at <= datetime('now', '-1 hour');   -- sweep is broken
--   SELECT COUNT(*) FROM payment_requests
--    WHERE status = 'sending' AND claimed_at <= datetime('now', '-1 hour');  -- reaper is broken
--   SELECT COUNT(*) FROM payment_requests
--    WHERE paid_email_sent = 0 AND status IN ('paid', 'refunded')
--      AND paid_at <= datetime('now', '-10 minutes');                        -- receipt never sent
--   SELECT COUNT(*) FROM stripe_connect_events
--    WHERE processed_at IS NULL AND received_at <= datetime('now', '-15 minutes');
--   SELECT COUNT(*) FROM unmatched_payments WHERE status = 'open';
--   SELECT COUNT(*) FROM payment_requests WHERE refunded_pence > 0 AND fee_refunded_pence = 0;
--   SELECT COUNT(*) FROM payment_requests
--    WHERE status IN ('paid', 'refunded') AND fee_collected_pence IS NOT NULL
--      AND fee_collected_pence <> fee_pence;                                 -- fee did not match
-- ===========================================================================
