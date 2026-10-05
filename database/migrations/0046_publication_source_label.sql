-- Article-level attribution is independent of collection provenance and its publication policy.
-- Nullable during rolling deployment; old rows continue to use sources.name until repaired.
ALTER TABLE publications ADD COLUMN source_label text;
