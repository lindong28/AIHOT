-- Read-only, rolling one-hour diagnostics. Estimates are not supplier billing.
BEGIN READ ONLY;
SELECT now() AS observed_at, '1 hour' AS request_window;
SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'socialdata';

WITH attempts AS (
  SELECT a.*, r.purpose, CASE WHEN a.status = 'received' THEN r.response END AS response
  FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
  WHERE a.service = 'socialdata' AND a.origin = 'live' AND a.started_at > now() - interval '1 hour'
), posts AS (
  SELECT purpose, t->>'id_str' AS tweet_id FROM attempts,
    jsonb_array_elements(coalesce(response->'tweets', '[]'::jsonb)) t
), objects AS (
  SELECT purpose, count(*) AS returned_search_posts, count(DISTINCT tweet_id) AS unique_search_posts FROM posts GROUP BY purpose
)
SELECT a.purpose, count(*) AS attempts,
  count(*) FILTER (WHERE a.response IS NOT NULL) AS saved_responses,
  count(*) FILTER (WHERE a.response->'tweets' = '[]'::jsonb) AS empty_search_pages,
  coalesce(o.returned_search_posts, 0) AS returned_search_posts,
  coalesce(o.returned_search_posts - o.unique_search_posts, 0) AS repeated_search_posts,
  sum(a.cost) FILTER (WHERE a.cost_basis = 'estimated' AND a.currency = 'USD') AS estimated_usd,
  count(*) FILTER (WHERE a.cost IS NULL) AS attempts_without_cost
FROM attempts a LEFT JOIN objects o USING (purpose)
GROUP BY a.purpose, o.returned_search_posts, o.unique_search_posts ORDER BY a.purpose;

SELECT count(*) AS enabled_x_sources,
  count(*) FILTER (WHERE cursor->>'initializedAt' IS NULL) AS awaiting_first_import,
  min(last_ok_at) AS oldest_successful_source_check,
  sum(jsonb_array_length(coalesce(cursor->'xBacklog', '[]'::jsonb))) AS source_backlog_entries
FROM sources WHERE kind = 'x_search' AND enabled;

-- The same shard range can be held by several sources, so deduplicate it here.
SELECT count(DISTINCT b::text) AS distinct_backlog_checkpoints,
  min(b->>'window') AS oldest_receipt_window,
  count(*) FILTER (WHERE b->>'error' IS NOT NULL) AS source_entries_needing_attention
FROM sources, jsonb_array_elements(coalesce(cursor->'xBacklog', '[]'::jsonb)) b
WHERE kind = 'x_search' AND enabled;

SELECT count(*) FILTER (WHERE processed_at IS NULL) AS monitor_pending_posts,
  min(published_at) FILTER (WHERE processed_at IS NULL) AS oldest_pending_post,
  count(*) FILTER (WHERE raw->>'contextPending' = 'true') AS awaiting_context
FROM monitor_posts WHERE author = 'thsottiaux';
SELECT key, value FROM monitor_state WHERE key IN ('cursor', 'watermarks');
COMMIT;
