#!/usr/bin/env bash
# P1.11: a THROWAWAY benchmark-only login role that skips row-level security, used only to measure
# what the policies cost. It is a member of ledgerline_app (so it has exactly the same table, schema
# and function privileges) plus BYPASSRLS, in the same database and on the same data and cache pages,
# so the only difference between the two modes is that the policies are not applied.
# Nothing in the migrations or the API changes: the API runs with the RLS-bound ledgerline_app role
# unless DATABASE_URL is set to this role's connection string for the duration of a benchmark, and
# the role is dropped afterwards (`drop`), which this script verifies.
# (A first attempt used CREATE DATABASE ... TEMPLATE to make a copy with RLS disabled; that crashed the
# Postgres container once during the 2.3 GB copy and was abandoned; the server recovered and the
# data was intact.)
#
#   ledgerline/k6/rls-off-role.sh create | verify | drop
# Every query the API runs already carries an explicit `tenant_id = $1` predicate (usage read,
# balance read, ingest insert), so "without RLS" still filters by tenant: only the policy is gone.
set -euo pipefail
ROLE=ledgerline_bench_norls
PSQL="docker exec -i ledgerworks-postgres psql -U ledgerworks -d ledgerworks -v ON_ERROR_STOP=1 -X -q -At"
case "${1:?create|verify|drop}" in
  create)
    $PSQL -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$ROLE') THEN CREATE ROLE $ROLE LOGIN PASSWORD '$ROLE' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE IN ROLE ledgerline_app; END IF; END \$\$"
    echo "created $ROLE (BYPASSRLS, member of ledgerline_app)" ;;
  verify)
    # As the app role, with no tenant set, RLS hides everything; as this role it does not.
    A=$(docker exec -e PGPASSWORD=ledgerline_app ledgerworks-postgres psql -h localhost -U ledgerline_app -d ledgerworks -X -At -c "SELECT count(*) FROM credit_balances")
    B=$(docker exec -e PGPASSWORD=$ROLE ledgerworks-postgres psql -h localhost -U $ROLE -d ledgerworks -X -At -c "SELECT count(*) FROM credit_balances")
    echo "credit_balances rows visible with no tenant set: ledgerline_app=$A (expect 0), $ROLE=$B (expect 250)" ;;
  drop)
    $PSQL -c "DROP ROLE IF EXISTS $ROLE"
    N=$($PSQL -c "SELECT count(*) FROM pg_roles WHERE rolname = '$ROLE' OR rolbypassrls AND rolname NOT IN ('ledgerworks')")
    echo "dropped $ROLE; roles with BYPASSRLS other than the superuser: $N (expect 0)" ;;
esac
