-- Additive only: existing historical content is not swept by this migration.
ALTER TABLE articles ADD COLUMN content_discarded_at timestamptz;
ALTER TABLE articles ADD COLUMN content_discard_after timestamptz;
ALTER TABLE article_revisions ADD COLUMN material_hash text;
CREATE INDEX articles_discard_due_idx ON articles(content_discard_after)
  WHERE content_discard_after IS NOT NULL AND content_discarded_at IS NULL;
ALTER TABLE backfill_items ADD COLUMN content_discarded_at timestamptz;
