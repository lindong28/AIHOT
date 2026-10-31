-- Private research organisation, independent of editorial tags and collection settings.
-- No default groups or aliases: membership is an explicit operator choice.
CREATE TABLE research_groups (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200)
);
CREATE TABLE research_group_sources (
  group_id text NOT NULL REFERENCES research_groups(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id,source_id)
);
CREATE TABLE research_source_aliases (
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (length(btrim(alias)) BETWEEN 1 AND 200),
  PRIMARY KEY (source_id,alias)
);
CREATE INDEX research_alias_lookup_idx ON research_source_aliases (lower(alias));
CREATE INDEX research_published_idx ON research_documents (published_at DESC,id DESC) WHERE published_at IS NOT NULL;
CREATE INDEX research_discovered_idx ON research_documents (discovered_at DESC,id DESC);
CREATE INDEX research_updated_cursor_idx ON research_documents (updated_at DESC,id DESC);
