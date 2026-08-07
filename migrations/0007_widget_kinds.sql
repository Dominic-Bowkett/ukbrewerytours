-- Widgets grow a second kind: embeddable CONTACT FORMS, managed from the same
-- admin tab and embedded the same way as voucher widgets. A contact widget's
-- iframe posts to /api/contact, which emails info@ (reply-to the sender) and
-- logs to enquiries exactly like the site's own form.

ALTER TABLE widgets ADD COLUMN kind TEXT NOT NULL DEFAULT 'voucher';
-- 'voucher' — the gift voucher shop (existing rows keep working untouched)
-- 'contact' — a get-in-touch form; preset/amount columns are ignored for these

-- Voucher widgets: admin-set suggested gift message, prefilled into the
-- "message" box when buying for someone else. The buyer can edit or clear it.
ALTER TABLE widgets ADD COLUMN gift_message TEXT NOT NULL DEFAULT '';

-- Which widget (and host site) an enquiry arrived through. Null for the
-- site's own contact form.
ALTER TABLE enquiries ADD COLUMN widget_id TEXT;
ALTER TABLE enquiries ADD COLUMN widget_origin TEXT;

CREATE INDEX IF NOT EXISTS idx_enquiries_widget ON enquiries(widget_id) WHERE widget_id IS NOT NULL;
