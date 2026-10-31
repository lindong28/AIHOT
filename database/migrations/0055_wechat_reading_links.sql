-- An alias belongs to the existing material identity, including material-only research records.
-- Original articles/publications/backfill URLs and historical ledger entries remain unchanged.
CREATE TABLE wechat_reading_links (
  identity_key text PRIMARY KEY,
  canonical_identity text NOT NULL UNIQUE,
  reading_url text NOT NULL UNIQUE,
  source_url text NOT NULL,
  page_url text NOT NULL,
  observed_at timestamptz NOT NULL,
  evidence_source text NOT NULL,
  evidence_hash text NOT NULL CHECK (length(evidence_hash)=64),
  created_at timestamptz NOT NULL DEFAULT now()
);
