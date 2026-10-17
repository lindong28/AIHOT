-- Read both historical double-copy receipts and the opt-in attempt-only format.
-- No historical payload rewrite; the attempt ledger remains intact.
CREATE FUNCTION receipt_response(r receipts) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(r.response, (SELECT a.response FROM receipt_attempts a
    WHERE a.receipt_id=r.id AND a.attempt=r.attempts))
$$;
