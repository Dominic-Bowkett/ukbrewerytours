-- Ad attribution: the last ad click (Google click id + UTM tags) a buyer or
-- enquirer arrived through, captured on any of the three sites and kept for 90
-- days in the browser. /api/ads/conversions turns paid orders, booking payments
-- and group enquiries that carry a gclid into Google Ads offline conversions.
--
-- gclid / gbraid / wbraid — Google's click ids (gbraid/wbraid come from iOS).
-- attribution — JSON: utm_source, utm_medium, utm_campaign, utm_term,
--               utm_content, landing (page the ad led to), clicked_at.
ALTER TABLE orders ADD COLUMN gclid TEXT;
ALTER TABLE orders ADD COLUMN gbraid TEXT;
ALTER TABLE orders ADD COLUMN wbraid TEXT;
ALTER TABLE orders ADD COLUMN attribution TEXT;

ALTER TABLE enquiries ADD COLUMN gclid TEXT;
ALTER TABLE enquiries ADD COLUMN gbraid TEXT;
ALTER TABLE enquiries ADD COLUMN wbraid TEXT;
ALTER TABLE enquiries ADD COLUMN attribution TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_gclid ON orders(gclid) WHERE gclid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_enquiries_gclid ON enquiries(gclid) WHERE gclid IS NOT NULL;
