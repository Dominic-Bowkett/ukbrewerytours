-- Inbound email: customer replies coming back into the conversation.
--
-- Every outbound email already carries a per-conversation Reply-To
-- (reply-<token>@<INBOUND_REPLY_DOMAIN>), so a reply identifies its own thread
-- and needs no matching guesswork. See functions/api/inbound-email.js.

-- Where a team member's own alerts go. Their login email is just a username —
-- london@ukbrewerytours.com is not a mailbox — so alerts must be addressed
-- somewhere real. Falls back to the login email when this is null.
ALTER TABLE team_members ADD COLUMN notify_email TEXT;

-- Dedupe inbound mail: webhooks retry, and a retry must not post the message twice.
CREATE INDEX IF NOT EXISTS idx_enquiry_messages_email_id ON enquiry_messages(email_id);
