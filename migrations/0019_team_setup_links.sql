-- One-time set-up links for team members: the member chooses their own password
-- at /team/setup.html#t=<token>, so no password is ever generated, shown or sent.
-- Only a SHA-256 of the token is stored; it expires and is cleared on use.
ALTER TABLE team_members ADD COLUMN setup_token_hash TEXT;
ALTER TABLE team_members ADD COLUMN setup_expires_at TEXT;
