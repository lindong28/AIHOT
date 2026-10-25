-- One durable issue per article, independent of feed windows and fetch-run retention.
CREATE TABLE wechat_body_issues (
  article_id text PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  first_error text NOT NULL,
  last_error text NOT NULL,
  stage text NOT NULL,
  resolved_at timestamptz
);
CREATE INDEX wechat_body_issues_open ON wechat_body_issues(article_id) WHERE resolved_at IS NULL;

-- Preserve known pre-upgrade gaps without inventing their original failure or attempt count.
INSERT INTO wechat_body_issues(article_id, first_error, last_error, stage)
SELECT a.id, '升级前已缺正文；原始失败原因未记录', '升级前已缺正文；原始失败原因未记录', 'legacy'
FROM articles a JOIN sources s ON s.id=a.source_id
WHERE s.kind='mp_account' AND s.config->>'provider'='wechat2rss'
  AND a.body_status<>'ok' AND a.content_discarded_at IS NULL;
