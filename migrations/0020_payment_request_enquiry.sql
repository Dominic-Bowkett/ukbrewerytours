-- A team payment request raised from an inbox conversation. The client's name and
-- email come from the conversation on the server, so the team member never sees
-- the address; the customer's reply goes back to the thread; and paying it is
-- logged on the conversation. NULL for requests raised from Team payments.
ALTER TABLE payment_requests ADD COLUMN enquiry_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_payment_requests_enquiry ON payment_requests(enquiry_id);
