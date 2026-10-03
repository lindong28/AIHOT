-- Preparation and publication share one immutable item identity and progress denominator.
ALTER TABLE backfill_runs ADD COLUMN scope text NOT NULL DEFAULT 'approved' CHECK (scope IN ('approved','history'));
ALTER TABLE backfill_runs ADD COLUMN preparation_identity jsonb;
ALTER TABLE backfill_items ADD COLUMN preparation jsonb;
ALTER TABLE backfill_items ADD COLUMN retry_after timestamptz;
CREATE INDEX backfill_items_retry_idx ON backfill_items(run_id,retry_after,day) WHERE state='pending';
