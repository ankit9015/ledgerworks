-- 0007: drop the redundant credit_ledger index (P1.10, O5 / E4). Runs as ledgerline_owner.
--
-- credit_ledger_tenant_id_idx (tenant_id, id), non-unique, from 0001, covers exactly the same
-- columns in the same order as the unique constraint credit_ledger_tenant_id_id_key added in 0003
-- (needed for the composite foreign key that keeps refunds inside one tenant). The constraint's
-- index serves every lookup the old one did, and both were maintained on every ledger insert.
DROP INDEX credit_ledger_tenant_id_idx;
