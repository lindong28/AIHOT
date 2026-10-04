-- Keep every received generation before application validation can request another.
ALTER TABLE receipt_attempts ADD COLUMN response jsonb;
ALTER TABLE receipt_attempts ADD COLUMN output_validation_error text;

-- Older attempts have no retained response; copy only the latest known response.
UPDATE receipt_attempts a SET response = r.response
FROM receipts r WHERE a.receipt_id = r.id AND a.attempt = r.attempts
  AND r.status IN ('received', 'completed') AND a.status = 'received'
  AND r.response IS NOT NULL;
