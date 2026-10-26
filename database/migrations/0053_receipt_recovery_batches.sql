-- Only explicitly web-authorized batches are picked up by the scheduled runner.
CREATE TABLE receipt_recovery_batches (
  batch text PRIMARY KEY,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  runner_error text
);
CREATE INDEX receipt_recovery_batches_created_idx ON receipt_recovery_batches(created_at);
CREATE INDEX receipt_reviews_consumed_idx ON receipt_reviews
  ((evidence->'reconsideration'->'consumed'->>'receiptId'), (evidence->'reconsideration'->'consumed'->>'attempt'))
  WHERE evidence->'reconsideration'->'consumed' IS NOT NULL;
