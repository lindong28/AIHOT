-- Sanitized Gateway failure metadata; historical billing and attempt states are unchanged.
ALTER TABLE receipt_attempts ADD COLUMN error_details jsonb;
