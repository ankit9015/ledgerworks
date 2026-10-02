-- 0009: create_usage_events_partition computes bounds in UTC (fix). Runs as ledgerline_owner.
--
-- The 0001 version built the bounds with date_trunc on a date (which casts through the session time
-- zone) and passed them to CREATE TABLE as bare date literals (interpreted in the session time zone),
-- so it was only correct because the server runs in UTC. ensure_usage_events_partitions_at (0008) has
-- used UTC from the start. This makes the two consistent. Same signature and result; existing
-- partitions are untouched (their bounds are already the UTC month boundaries, which a test asserts).
CREATE OR REPLACE FUNCTION create_usage_events_partition(p_month date) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_start date := date_trunc('month', p_month::timestamp)::date;
  v_end   date := (date_trunc('month', p_month::timestamp) + interval '1 month')::date;
  v_name  text := format('usage_events_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
    v_name,
    to_char(v_start, 'YYYY-MM-DD') || ' 00:00:00+00',
    to_char(v_end, 'YYYY-MM-DD') || ' 00:00:00+00');
  RETURN v_name;
END $$;
