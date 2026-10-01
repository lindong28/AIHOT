-- Managed history has its own durable work list; the live worker never owns these articles.
CREATE TABLE backfill_runs (
  id text PRIMARY KEY,
  label text NOT NULL,
  manifest_hash text NOT NULL UNIQUE,
  start_day date NOT NULL,
  end_day date NOT NULL CHECK (end_day >= start_day),
  state text NOT NULL DEFAULT 'paused' CHECK (state IN ('paused','ready','running','waiting_models','needs_attention','complete')),
  models jsonb,
  heartbeat_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE articles ADD COLUMN managed_backfill_id text REFERENCES backfill_runs(id);
CREATE INDEX articles_managed_backfill_idx ON articles(managed_backfill_id) WHERE managed_backfill_id IS NOT NULL;
CREATE TABLE backfill_items (
  run_id text NOT NULL REFERENCES backfill_runs(id),
  identity_key text NOT NULL,
  day date,
  material jsonb NOT NULL,
  content_hash text NOT NULL,
  evidence text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','excluded','running','published','filtered','existing','failed')),
  reason text,
  article_id text REFERENCES articles(id),
  article_revision integer,
  article_hash text,
  stage text,
  model text,
  attempts integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, identity_key)
);
CREATE INDEX backfill_items_work_idx ON backfill_items(run_id, state, day);
INSERT INTO budgets(service, per_minute, per_hour, per_day, note)
VALUES ('backfill', 300, 6000, 40000, '历史回填独立熔断；并发按自部署 GPU 容量配置') ON CONFLICT DO NOTHING;
