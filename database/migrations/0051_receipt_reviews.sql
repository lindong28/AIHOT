-- Operator/business disposition is independent of the original transport and cost facts.
CREATE TABLE receipt_reviews (
  receipt_id bigint NOT NULL REFERENCES receipts(id),
  attempt integer NOT NULL,
  outcome text NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('unknown','content_policy_rejected','invalid_request')),
  disposition text NOT NULL DEFAULT 'open' CHECK (disposition IN ('open','stopped','superseded')),
  billed boolean,
  note text NOT NULL,
  actor text NOT NULL,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (receipt_id, attempt),
  FOREIGN KEY (receipt_id, attempt) REFERENCES receipt_attempts(receipt_id, attempt)
);

-- Existing UUIDs retain their original request body across upgrades.
ALTER TABLE receipt_attempts ADD COLUMN output_retry_hint boolean NOT NULL DEFAULT false;
