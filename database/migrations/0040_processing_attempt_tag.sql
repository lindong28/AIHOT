-- A deferred analysis retry must keep the original run identity and reuse paid stages.
ALTER TABLE articles ADD COLUMN processing_attempt_tag text;
