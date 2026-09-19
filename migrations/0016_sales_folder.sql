-- A Sales folder for the site's own voucher-sale heads-ups.
--
-- info@ forwards into the helpdesk, and info@ is also where the site emails
-- itself when a voucher sells. Those came straight back in as one "customer"
-- called Info, each sale emailing an alert. They are notifications (no alert,
-- no badge, never shown to a team member); this says which kind, so sales get
-- a folder of their own instead of sitting among Stripe receipts.
--
-- NULL = an ordinary notification; 'sale' = a voucher sale.

ALTER TABLE enquiries ADD COLUMN notification_kind TEXT;
