-- Private research projection. Original records remain authoritative. No initial corpus scan here:
-- scripts/research-index.ts builds existing identities in resumable batches before enabling access.
CREATE TABLE research_documents (
  identity_key text PRIMARY KEY,
  id text NOT NULL UNIQUE,
  article_id text,
  run_id text,
  source_id text NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  author text,
  language text,
  published_at timestamptz,
  discovered_at timestamptz NOT NULL,
  sort_at timestamptz NOT NULL,
  first_indexed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision integer,
  content_hash text,
  body_text text,
  body_html text,
  -- Raw preparation JSON preserves code units PostgreSQL text cannot store (NUL/lone surrogate).
  body_json_text text,
  body_json_html text,
  title_json text,
  author_json text,
  material_version text,
  discarded boolean NOT NULL,
  evidence text
);
CREATE INDEX research_documents_time_idx ON research_documents(sort_at DESC, id DESC);
CREATE INDEX research_documents_source_idx ON research_documents(source_id, sort_at DESC, id DESC);
CREATE INDEX research_documents_article_idx ON research_documents(article_id);
CREATE INDEX research_documents_updated_idx ON research_documents(updated_at DESC);
CREATE INDEX research_documents_title_idx ON research_documents USING gin(lower(title) gin_trgm_ops);
CREATE INDEX research_documents_body_idx ON research_documents USING gin(lower(coalesce(body_text,'')) gin_trgm_ops);
CREATE INDEX research_documents_json_body_idx ON research_documents USING gin(lower(coalesce(body_json_text,'')) gin_trgm_ops);
CREATE INDEX research_backfill_identity_idx ON backfill_items(identity_key, updated_at DESC, run_id);
CREATE INDEX research_backfill_article_idx ON backfill_items(article_id) WHERE article_id IS NOT NULL;
CREATE TABLE research_index_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  article_cursor text,
  material_cursor text,
  articles_complete boolean NOT NULL DEFAULT false,
  materials_complete boolean NOT NULL DEFAULT false
);
INSERT INTO research_index_state(singleton) VALUES(true);

CREATE FUNCTION research_refresh(k text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a articles%ROWTYPE; b backfill_items%ROWTYPE; pub timestamptz; discovered timestamptz;
  m jsonb; raw jsonb; version_key text; source_key text; original_url text; original_title text;
BEGIN
  -- Serialize competing imports of the same identity, without locking unrelated documents.
  PERFORM pg_advisory_xact_lock(hashtextextended(k, 4831));
  SELECT * INTO a FROM articles WHERE identity_key=k;
  IF FOUND THEN
    INSERT INTO research_documents(id,identity_key,article_id,source_id,url,title,author,language,published_at,
      discovered_at,sort_at,revision,content_hash,body_text,body_html,discarded)
    VALUES('doc_' || encode(sha256(convert_to(k,'UTF8')),'hex'),k,a.id,a.source_id,a.url,a.title,a.author,a.language,a.published_at,a.discovered_at,
      coalesce(a.published_at,a.discovered_at),a.revision,a.content_hash,a.body_text,a.body_html,a.content_discarded_at IS NOT NULL)
    ON CONFLICT(identity_key) DO UPDATE SET article_id=EXCLUDED.article_id,run_id=NULL,source_id=EXCLUDED.source_id,
      url=EXCLUDED.url,title=EXCLUDED.title,author=EXCLUDED.author,language=EXCLUDED.language,published_at=EXCLUDED.published_at,
      discovered_at=EXCLUDED.discovered_at,revision=EXCLUDED.revision,content_hash=EXCLUDED.content_hash,
      body_text=EXCLUDED.body_text,body_html=EXCLUDED.body_html,body_json_text=NULL,body_json_html=NULL,
      title_json=NULL,author_json=NULL,material_version=NULL,discarded=EXCLUDED.discarded,evidence=NULL,updated_at=clock_timestamp();
    RETURN;
  END IF;
  -- Keep cleared identities as tombstones; never resurrect an older retained version after clearing.
  SELECT * INTO b FROM backfill_items WHERE identity_key=k ORDER BY updated_at DESC,run_id DESC LIMIT 1;
  IF NOT FOUND THEN DELETE FROM research_documents WHERE identity_key=k; RETURN; END IF;
  m := b.material;
  IF b.content_discarded_at IS NULL AND (m->>'sourceId' IS NULL OR m->>'url' IS NULL) THEN
    -- importHistory freezes originals here before prefiltering; a BLOCK never fills material.
    -- storePreparation supplies safe derived scalars. The explicit builder upgrades old envelopes.
    raw := b.preparation->'research'; m := raw; version_key := raw->>'versionKey';
  END IF;
  source_key := m->>'sourceId'; original_url := m->>'url'; original_title := m->>'title';
  IF b.content_discarded_at IS NOT NULL THEN
    -- Retention can erase all metadata. Preserve an existing identity or derive a URL tombstone.
    SELECT source_id,url INTO source_key,original_url FROM research_documents WHERE identity_key=k;
    source_key := coalesce(source_key,'unknown');
    original_url := coalesce(original_url,CASE WHEN k LIKE 'url:%' THEN substring(k from 5)
      WHEN k LIKE 'x:%' THEN 'https://x.com/i/status/'||substring(k from 3) END);
    original_title := '已清除资料'; m := NULL; raw := NULL;
  END IF;
  IF source_key IS NULL OR original_url IS NULL THEN DELETE FROM research_documents WHERE identity_key=k; RETURN; END IF;
  BEGIN pub := (m->>'publishedAt')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN pub := NULL;
  END;
  SELECT created_at INTO discovered FROM backfill_runs WHERE id=b.run_id;
  INSERT INTO research_documents(id,identity_key,run_id,source_id,url,title,author,language,published_at,
    discovered_at,sort_at,content_hash,body_json_text,body_json_html,title_json,author_json,material_version,discarded,evidence)
  VALUES('doc_' || encode(sha256(convert_to(k,'UTF8')),'hex'),k,b.run_id,source_key,original_url,coalesce(original_title,''),m->>'author',
    m->>'language',pub,discovered,coalesce(pub,discovered),
    CASE WHEN version_key IS NULL THEN b.content_hash ELSE raw->>'contentHash' END,
    CASE WHEN raw IS NULL THEN (m->'bodyText')::text ELSE raw->>'bodyTextJson' END,
    CASE WHEN raw IS NULL THEN (m->'bodyHtml')::text ELSE raw->>'bodyHtmlJson' END,
    CASE WHEN raw IS NULL THEN (m->'title')::text ELSE raw->>'titleJson' END,
    CASE WHEN raw IS NULL THEN (m->'author')::text ELSE raw->>'authorJson' END,version_key,b.content_discarded_at IS NOT NULL,b.evidence)
  ON CONFLICT(identity_key) DO UPDATE SET article_id=NULL,run_id=EXCLUDED.run_id,source_id=EXCLUDED.source_id,
    url=EXCLUDED.url,title=EXCLUDED.title,author=EXCLUDED.author,language=EXCLUDED.language,published_at=EXCLUDED.published_at,
    discovered_at=EXCLUDED.discovered_at,revision=NULL,content_hash=EXCLUDED.content_hash,
    body_text=NULL,body_html=NULL,body_json_text=EXCLUDED.body_json_text,body_json_html=EXCLUDED.body_json_html,
    title_json=EXCLUDED.title_json,author_json=EXCLUDED.author_json,material_version=EXCLUDED.material_version,
    discarded=EXCLUDED.discarded,evidence=EXCLUDED.evidence,updated_at=clock_timestamp();
END $$;

CREATE FUNCTION research_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN PERFORM research_refresh(OLD.identity_key); RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND OLD.identity_key<>NEW.identity_key THEN PERFORM research_refresh(OLD.identity_key); END IF;
  PERFORM research_refresh(NEW.identity_key);
  RETURN NEW;
END $$;
CREATE TRIGGER research_article_sync AFTER INSERT OR DELETE OR UPDATE OF identity_key,source_id,url,title,author,language,
  published_at,discovered_at,revision,content_hash,body_text,body_html,content_discarded_at ON articles
  FOR EACH ROW EXECUTE FUNCTION research_sync();
CREATE TRIGGER research_material_sync AFTER INSERT OR DELETE OR UPDATE OF identity_key,material,content_hash,evidence,
  article_id,preparation,content_discarded_at,updated_at ON backfill_items FOR EACH ROW EXECUTE FUNCTION research_sync();
