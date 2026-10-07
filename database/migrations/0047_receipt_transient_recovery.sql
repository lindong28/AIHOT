-- Recovery sends reuse a Gateway UUID; they are not extra model generations.
ALTER TABLE receipts ADD COLUMN retry_after timestamptz;
ALTER TABLE receipts ADD COLUMN recovery_exhausted boolean NOT NULL DEFAULT false;
ALTER TABLE receipt_attempts ADD COLUMN recovery_sends integer NOT NULL DEFAULT 1 CHECK (recovery_sends > 0);
ALTER TABLE receipt_attempts ADD COLUMN recovery_action text CHECK (recovery_action IN ('retry_same_request','retry_new_request','stop'));
