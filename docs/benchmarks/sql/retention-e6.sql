-- E6: retention of one month (2025-10, 547,332 rows): DELETE from an unpartitioned table against
-- DETACH + DROP of a partition. Scratch objects only (scratch_flat is a copy of usage_events),
-- superuser, psql \timing in ms, 3 repetitions each (the month is re-inserted, untimed, between).
\timing on
\echo '--- flat table: DELETE one month'
DELETE FROM scratch_flat WHERE occurred_at >= '2025-10-01' AND occurred_at < '2025-11-01';
SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'scratch_flat' \gset
INSERT INTO scratch_flat SELECT * FROM usage_events_2025_10;
\echo '--- flat table: DELETE one month (2)'
DELETE FROM scratch_flat WHERE occurred_at >= '2025-10-01' AND occurred_at < '2025-11-01';
INSERT INTO scratch_flat SELECT * FROM usage_events_2025_10;
\echo '--- flat table: DELETE one month (3)'
DELETE FROM scratch_flat WHERE occurred_at >= '2025-10-01' AND occurred_at < '2025-11-01';

DROP TABLE IF EXISTS scratch_parent;
CREATE TABLE scratch_parent (LIKE usage_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS) PARTITION BY RANGE (occurred_at);
ALTER TABLE scratch_parent ADD PRIMARY KEY (id, occurred_at);
CREATE INDEX ON scratch_parent (tenant_id, occurred_at);
\timing off
DO $$ BEGIN
  FOR i IN 1..3 LOOP
    EXECUTE format('CREATE TABLE scratch_p_%s PARTITION OF scratch_parent FOR VALUES FROM (%L) TO (%L)', i, '2025-10-01', '2025-11-01');
    EXECUTE format('INSERT INTO scratch_p_%s SELECT * FROM usage_events_2025_10', i);
    EXECUTE format('ALTER TABLE scratch_parent DETACH PARTITION scratch_p_%s', i);
    -- reattach under another name is not possible with the same bounds, so each repetition is
    -- built, timed and dropped on its own below
    EXECUTE format('DROP TABLE scratch_p_%s', i);
  END LOOP;
END $$;
\echo '--- partition: DETACH + DROP one month (3 repetitions, each on a freshly loaded partition)'
CREATE TABLE scratch_p_a PARTITION OF scratch_parent FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
INSERT INTO scratch_p_a SELECT * FROM usage_events_2025_10;
\timing on
ALTER TABLE scratch_parent DETACH PARTITION scratch_p_a;
DROP TABLE scratch_p_a;
\timing off
CREATE TABLE scratch_p_a PARTITION OF scratch_parent FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
INSERT INTO scratch_p_a SELECT * FROM usage_events_2025_10;
\timing on
ALTER TABLE scratch_parent DETACH PARTITION scratch_p_a;
DROP TABLE scratch_p_a;
\timing off
CREATE TABLE scratch_p_a PARTITION OF scratch_parent FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
INSERT INTO scratch_p_a SELECT * FROM usage_events_2025_10;
\timing on
ALTER TABLE scratch_parent DETACH PARTITION scratch_p_a;
DROP TABLE scratch_p_a;
\timing off
DROP TABLE scratch_parent;
