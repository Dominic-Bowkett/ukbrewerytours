-- Optional estimate on a payment request (usually a deposit): guests x price per
-- guest. booking_total_pence (existing) holds the product, so the email and the
-- pay page can show "estimated total" and "estimated balance remaining".
ALTER TABLE payment_requests ADD COLUMN guest_count INTEGER;
ALTER TABLE payment_requests ADD COLUMN price_per_guest_pence INTEGER;
