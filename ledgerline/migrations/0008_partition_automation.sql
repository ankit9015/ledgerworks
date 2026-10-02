-- 0008: automatic monthly partition creation for usage_events (P1.10, E6). Runs as ledgerline_owner.
--
-- 0001 created 48 partitions (2024-01 .. 2027-12) and there is no default partition, so an event
-- dated beyond the last partition is rejected (422). These functions keep the next N months present.
--
--   ledgerline_fn.ensure_usage_events_partitions(p_months_ahead)      for the API/CLI (app role)
--   ledgerline_fn.ensure_usage_events_partitions_at(p_now, p_months)  the same with an injectable
--                                                                     clock; owner/admin only
--
-- Safe to run repeatedly and concurrently:
--   * idempotent: a month that already has its partition is skipped;
--   * serialised: a transaction-level advisory lock makes concurrent callers queue up (the second
--     one finds the partitions the first created and does nothing);
--   * does not block inserts or reads: the partition is built as a standalone table (with the same
--     defaults, constraints and indexes) and then ATTACHed, which takes only SHARE UPDATE EXCLUSIVE
--     on the parent. CREATE TABLE ... PARTITION OF would take ACCESS EXCLUSIVE on the parent.
--   * month bounds are computed in UTC, independent of the session time zone.
-- SECURITY DEFINER (owner = ledgerline_owner, which owns the tables) because creating a partition
-- needs ownership; the app role cannot create tables. The body only formats names computed from a
-- month number and takes nothing else from the caller. p_months_ahead is capped at 24.

CREATE FUNCTION ledgerline_fn.ensure_usage_events_partitions_at(
  p_now timestamptz, p_months_ahead integer)
RETURNS TABLE (partition_name text, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_first date := date_trunc('month', p_now AT TIME ZONE 'UTC')::date;
  v_month date;
  v_name  text;
  v_lo    timestamptz;
  v_hi    timestamptz;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 0 OR p_months_ahead > 24 THEN
    RAISE EXCEPTION 'p_months_ahead must be between 0 and 24' USING ERRCODE = '22023';
  END IF;
  -- 727274 is the migration runner's lock; use a different key.
  PERFORM pg_advisory_xact_lock(727275);
  FOR i IN 0 .. p_months_ahead LOOP
    v_month := (v_first + make_interval(months => i))::date;
    v_name := format('usage_events_%s', to_char(v_month, 'YYYY_MM'));
    IF to_regclass(format('public.%I', v_name)) IS NOT NULL THEN
      partition_name := v_name; created := false;
      RETURN NEXT;
      CONTINUE;
    END IF;
    v_lo := v_month::timestamp AT TIME ZONE 'UTC';
    v_hi := (v_month + interval '1 month')::timestamp AT TIME ZONE 'UTC';
    EXECUTE format(
      'CREATE TABLE public.%I (LIKE public.usage_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)',
      v_name);
    EXECUTE format(
      'ALTER TABLE public.usage_events ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',
      v_name, v_lo, v_hi);
    partition_name := v_name; created := true;
    RETURN NEXT;
  END LOOP;
END $$;

CREATE FUNCTION ledgerline_fn.ensure_usage_events_partitions(p_months_ahead integer DEFAULT 3)
RETURNS TABLE (partition_name text, created boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT * FROM ledgerline_fn.ensure_usage_events_partitions_at(now(), p_months_ahead)
$$;

REVOKE EXECUTE ON FUNCTION ledgerline_fn.ensure_usage_events_partitions_at(timestamptz, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION ledgerline_fn.ensure_usage_events_partitions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ledgerline_fn.ensure_usage_events_partitions(integer) TO ledgerline_app;
