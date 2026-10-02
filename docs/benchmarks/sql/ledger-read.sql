-- O5: a tenant's latest ledger entries (the lookup the redundant index was meant to serve).
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, amount, kind, created_at FROM credit_ledger
WHERE tenant_id = :TENANT ORDER BY id DESC LIMIT 20;
