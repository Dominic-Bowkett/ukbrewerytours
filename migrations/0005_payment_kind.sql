-- Payment kind: a booking is usually a deposit then a balance, but sometimes
-- there are extra payments on top (added guests, an upgrade, a late addition).
--
-- parent_request_id already links a follow-up to the original. This adds what
-- KIND of payment each one is, so the client's email and pay page can say
-- "Balance for …" rather than repeating the full booking as if it were new,
-- and so the team can see at a glance what a booking is still owed.
--
-- A separate migration rather than an edit to 0004: 0004 has been applied to
-- local and preview databases already, and editing an applied migration is how
-- environments silently diverge.

ALTER TABLE payment_requests ADD COLUMN payment_kind TEXT NOT NULL DEFAULT 'full';

-- 'full'    — the whole amount in one go (the default)
-- 'deposit' — first payment against a booking
-- 'balance' — the remainder, normally linked to the deposit via parent_request_id
-- 'extra'   — an additional payment on an existing booking
CREATE INDEX IF NOT EXISTS idx_pr_kind ON payment_requests(team_member_id, payment_kind)
  WHERE payment_kind <> 'full';

-- The booking total a deposit/balance pair is working towards, when the member
-- knows it up front. Null when the booking has no agreed total (ad-hoc extras).
ALTER TABLE payment_requests ADD COLUMN booking_total_pence INTEGER;
