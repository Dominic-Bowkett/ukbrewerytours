-- Purchase attribution: the full URL of the page the buyer started checkout
-- from — the host page for widget purchases, the site page for the pop-up.
-- Opens already carry this in widget_events.page; this adds the same for
-- checkouts/purchases so the conversion dashboard can show where sales come
-- from, not just where the form was opened.
ALTER TABLE orders ADD COLUMN page TEXT;
