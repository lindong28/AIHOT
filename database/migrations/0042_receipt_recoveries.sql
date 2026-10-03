-- Business recovery is separate from the outcome/cost of the original paid attempt.
CREATE TABLE receipt_recoveries (
  receipt_id bigint NOT NULL REFERENCES receipts(id),
  original_attempt integer NOT NULL,
  batch text NOT NULL,
  target_key text NOT NULL,
  target jsonb NOT NULL,
  state text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','queued','recovered','blocked')),
  note text NOT NULL,
  original_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  recovered_at timestamptz,
  evidence jsonb,
  PRIMARY KEY (receipt_id, original_attempt)
);
CREATE INDEX receipt_recoveries_batch_idx ON receipt_recoveries(batch, state, target_key);
