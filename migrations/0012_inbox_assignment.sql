-- Assigning conversations to team members.
--
-- A team member with inbox_access = 1 sees ONLY the conversations assigned to
-- them (functions/api/team/inbox/* scope every query on assigned_to), replies
-- from their own address, and can never see anyone else's. The admin sees
-- everything, assigns and unassigns, and can reply on any conversation.
--
-- Reuses team_members (already the login, lockout and revocation model for the
-- team area) rather than inventing a second kind of user: inbox-only members
-- simply have no Stripe account attached.

ALTER TABLE enquiries ADD COLUMN assigned_to TEXT REFERENCES team_members(id);
ALTER TABLE enquiries ADD COLUMN assigned_at TEXT;
ALTER TABLE enquiries ADD COLUMN assigned_by TEXT;              -- admin email

CREATE INDEX IF NOT EXISTS idx_enquiries_assigned ON enquiries(assigned_to, status, last_message_at);

-- 1 = may use the shared inbox at /team/. Existing payment-only members stay 0.
ALTER TABLE team_members ADD COLUMN inbox_access INTEGER NOT NULL DEFAULT 0 CHECK (inbox_access IN (0, 1));
-- Replies this member sends go out from here (falls back to their login email).
-- The address must be on a domain verified in Resend, and needs a real mailbox
-- or alias if customers are to be able to reply to it.
ALTER TABLE team_members ADD COLUMN inbox_from_email TEXT;
-- Shown to customers as the sender name, e.g. "London Brewery Tours".
ALTER TABLE team_members ADD COLUMN inbox_from_name TEXT;
