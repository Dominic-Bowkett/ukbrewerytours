-- Auto-replies: stock replies chosen by rules, and AI drafts.
--
-- reply_rules — checked in priority order when a NEW conversation arrives; the
-- first enabled rule whose conditions all hold wins. action 'send' emails the
-- reply at once (from info@, logged on the thread); 'draft' puts it in the reply
-- box for the admin. Empty condition = any.
CREATE TABLE IF NOT EXISTS reply_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,      -- lower runs first
  action TEXT NOT NULL DEFAULT 'draft' CHECK (action IN ('draft', 'send')),
  types TEXT,                                -- comma list of enquiry types; empty = any
  cities TEXT,                               -- comma list (London, Bristol…); empty = any
  min_group INTEGER,                         -- group size at least…
  max_group INTEGER,                         -- …and at most
  keywords TEXT,                             -- comma list; any one must appear; empty = none needed
  body TEXT NOT NULL,                        -- {first name} {name} {city} {group size} {date}
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the admin's reply box opens with: a stock reply or an AI draft.
ALTER TABLE enquiries ADD COLUMN suggested_reply TEXT;
ALTER TABLE enquiries ADD COLUMN suggested_source TEXT;   -- 'rule:<name>' | 'ai'

-- Small admin settings that are not money settings: the AI key (encrypted with a
-- key derived from ADMIN_SESSION_SECRET), model, instructions, on/off.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
