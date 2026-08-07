-- Embeddable voucher widgets: created in /admin/, embedded on OTHER websites
-- (Bristol Brewery Tours, London Brewery Tours, …) via a <script> snippet.
-- The widget itself is an iframe served from /embed/widget/<id>; purchases go
-- through the normal create-checkout → Stripe → webhook flow, so vouchers sold
-- through a widget are ordinary UK Brewery Tours vouchers, just tagged with
-- where they were sold.

CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY,                       -- wgt_XXXXXXXXXX (same unambiguous alphabet as voucher codes)
  name TEXT NOT NULL,                        -- internal label, e.g. "Bristol Brewery Tours website"
  heading TEXT NOT NULL DEFAULT '',          -- title shown to the customer ('' = default copy)
  blurb TEXT NOT NULL DEFAULT '',            -- intro sentence under the heading ('' = default copy)
  accent_color TEXT NOT NULL DEFAULT '',     -- #rrggbb used for buttons/highlights ('' = house amber)
  preset_amounts TEXT NOT NULL DEFAULT '[2500,5000,10000]',  -- JSON array of pence, shown as quick-pick buttons
  allow_custom INTEGER NOT NULL DEFAULT 1,   -- 1 = customer may type their own amount
  allowed_origins TEXT NOT NULL DEFAULT '[]',-- JSON array of origins allowed to iframe it; [] = anywhere
  status TEXT NOT NULL DEFAULT 'active',     -- active | paused (paused shows a polite "unavailable" card)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which widget (and which page on the host site) a purchase came from.
-- Null for purchases made on ukbrewerytours.com itself.
ALTER TABLE orders ADD COLUMN widget_id TEXT;
ALTER TABLE orders ADD COLUMN widget_origin TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_widget ON orders(widget_id) WHERE widget_id IS NOT NULL;
