# Optimization log

One entry per performance win. Every entry must contain all of the following, with real output pasted from a real run (never estimated):

1. **Slow query**: the exact SQL and the endpoint or code path it serves.
2. **`EXPLAIN (ANALYZE, BUFFERS)` before**: full plan output.
3. **Change**: the index, schema change or query rewrite, as the exact SQL or diff.
4. **`EXPLAIN (ANALYZE, BUFFERS)` after**: full plan output.
5. **Measured latency before and after**: with the number of runs and how they were taken.
6. **Seed size**: rows per relevant table, plus the Postgres version and container CPU/memory limits (see `docker-compose.yml`). Label synthetic data as synthetic.

## Entries

_None yet. Entries are added in P1.10._
