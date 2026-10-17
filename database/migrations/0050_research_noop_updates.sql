-- Preserve winner selection while avoiding unchanged body/index rewrites. No corpus scan.
CREATE OR REPLACE FUNCTION research_refresh(k text) RETURNS void LANGUAGE plpgsql AS $$
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
      title_json=NULL,author_json=NULL,material_version=NULL,discarded=EXCLUDED.discarded,evidence=NULL,updated_at=clock_timestamp()
    WHERE ROW(research_documents.article_id,research_documents.run_id,research_documents.source_id,research_documents.url,research_documents.title,research_documents.author,research_documents.language,research_documents.published_at,research_documents.discovered_at,research_documents.revision,research_documents.content_hash,research_documents.body_text,research_documents.body_html,research_documents.body_json_text,research_documents.body_json_html,research_documents.title_json,research_documents.author_json,research_documents.material_version,research_documents.discarded,research_documents.evidence)
      IS DISTINCT FROM ROW(EXCLUDED.article_id,NULL,EXCLUDED.source_id,EXCLUDED.url,EXCLUDED.title,EXCLUDED.author,EXCLUDED.language,EXCLUDED.published_at,EXCLUDED.discovered_at,EXCLUDED.revision,EXCLUDED.content_hash,EXCLUDED.body_text,EXCLUDED.body_html,NULL,NULL,NULL,NULL,NULL,EXCLUDED.discarded,NULL);
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
    discarded=EXCLUDED.discarded,evidence=EXCLUDED.evidence,updated_at=clock_timestamp()
    WHERE ROW(research_documents.article_id,research_documents.run_id,research_documents.source_id,research_documents.url,research_documents.title,research_documents.author,research_documents.language,research_documents.published_at,research_documents.discovered_at,research_documents.revision,research_documents.content_hash,research_documents.body_text,research_documents.body_html,research_documents.body_json_text,research_documents.body_json_html,research_documents.title_json,research_documents.author_json,research_documents.material_version,research_documents.discarded,research_documents.evidence)
      IS DISTINCT FROM ROW(NULL,EXCLUDED.run_id,EXCLUDED.source_id,EXCLUDED.url,EXCLUDED.title,EXCLUDED.author,EXCLUDED.language,EXCLUDED.published_at,EXCLUDED.discovered_at,NULL,EXCLUDED.content_hash,NULL,NULL,EXCLUDED.body_json_text,EXCLUDED.body_json_html,EXCLUDED.title_json,EXCLUDED.author_json,EXCLUDED.material_version,EXCLUDED.discarded,EXCLUDED.evidence);
END $$;

