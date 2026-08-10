-- ---------------------------------------------------------------------------
-- reminders — one-shot emails to ourselves, sent by the scheduler Worker.
--
-- Exists because the alternatives do not actually deliver. A calendar entry is
-- not an email; a Gmail connector that can only draft leaves the message
-- sitting unsent; a note in a doc is not a reminder at all. This table plus the
-- five-minute sweep already running in workers/scheduler/ is the only path we
-- own end to end: our D1, our Resend key, our cron.
--
-- Deliberately the SAME claim/reap shape as payment_requests, so it inherits
-- the same guarantees rather than inventing weaker ones — one atomic claim so
-- two overlapping ticks cannot both send, a reaper for a worker that dies
-- mid-send, and a bounded attempt count so a permanent failure stops rather
-- than emailing forever.
--
-- Idempotent throughout: re-applying this migration must never drop a pending
-- reminder or resend a sent one.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,

  -- SQLite's own format, matching datetime('now'). The LIKE guard is
  -- load-bearing: an ISO string with a 'T' in it compares wrong against
  -- datetime('now'), so the row would sit pending forever with nothing to show
  -- for it. Same trap as payment_requests.send_at.
  send_at TEXT NOT NULL CHECK (send_at LIKE '____-__-__ __:__:__'),

  to_email TEXT NOT NULL CHECK (to_email = lower(to_email)),
  subject TEXT NOT NULL,

  -- Plain text with blank lines between paragraphs, and lines starting '- '
  -- rendered as bullets. Not markdown: this is a note to ourselves, and a
  -- second markdown parser is a second thing to get wrong.
  body TEXT NOT NULL,

  -- Optional context line under the heading, e.g. what the reminder is about.
  intro TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),

  -- Claim state, exactly as payment_requests uses it. The matching table-level
  -- CHECK is at the foot of the definition, not here: in SQLite the first
  -- table-level constraint ends the column list, and anything after it is a
  -- syntax error.
  claim_id TEXT,
  claimed_at TEXT,

  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  last_error TEXT,

  sent_at TEXT,
  message_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- A 'sending' row with no claim is unownable: no reaper can prove it is
  -- stale and no sender can prove it is theirs.
  CHECK (status <> 'sending' OR claim_id IS NOT NULL)
);

-- The sweep's only query: due and still pending.
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(send_at) WHERE status = 'pending';
-- The reaper's query.
CREATE INDEX IF NOT EXISTS idx_reminders_claimed ON reminders(claimed_at) WHERE status = 'sending';
