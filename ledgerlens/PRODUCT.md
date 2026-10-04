# Ledgerlens: PRODUCT.md

Ledgerlens finds slow queries in a Postgres database, proposes fixes, and **verifies each fix on a shadow copy** with measured before and after numbers. It never changes the source database and never applies anything automatically. Accepting a fix only exports a reviewable migration. The detailed plan is section 5 of `plan.md`.

## Persona

**Sam, a backend developer at a small startup with no DBA.** Sam's app got slow after a few months of growth. Sam knows SQL and the ORM, has read-only access to a production-like Postgres 16 database, and does not know how to read a query plan or which index would help. Sam will not run a statement on production that nobody has measured, and does not trust a tool that says "10x faster" without numbers.

## Problem

Slow queries are visible in `pg_stat_statements`, but turning that list into a safe fix takes skills Sam does not have: reading plans, finding the real parameter values, choosing index columns and their order, and knowing whether a new index slows writes more than it speeds reads. Advice from a model or a blog post is a guess until it is measured.

## Goals

1. Show the slowest statements of the real workload, ranked, with the plain-language reason each one is slow.
2. Propose a small number of concrete fixes (mostly indexes), each with up and down SQL.
3. Verify each fix on a settled shadow copy, interleaved before and after, and say plainly when the result is noise.
4. Report write overhead, storage cost and a risk level next to every speedup.
5. Be honest about what could not be checked: statements without usable parameter values are listed as unverifiable, never skipped.

## Non-goals

1. **No auto-apply.** Nothing is ever run on the source database. The output is a migration file a human reviews.
2. **No rewriting of application code.** Ledgerlens may describe a query rewrite as advice; it does not edit the application or its ORM calls.
3. **Not a monitoring replacement.** It looks at the statistics that exist at investigation time. It does not alert, trend or store history for dashboards.
4. **Not a general DBA.** Index and statistics advice for read-heavy slow queries. No configuration tuning, partitioning design, replication or vacuum policy.
5. **Not a benchmark of the production machine.** Timings come from a laptop-sized shadow; they compare a statement with and without a fix, not production latency.

## Success metrics

Targets are set before measuring. Results are filled in only from real runs (the gauntlet, L3.8 and L3.9). No target is invented here where none has been measured.

| #   | Metric                                                                                                      | Target                 | Result                       |
| --- | ----------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------- |
| 1   | Planted problems fixed with a verified speedup (gauntlet counts, dev and held-out sets reported separately) | counts, to be measured | not measured yet             |
| 2   | Fixes reported as an improvement that are harmful or useless when re-measured                               | 0                      | not measured yet             |
| 3   | Trap cases ("do not add an index") where Ledgerlens recommends an index                                     | 0                      | not measured yet             |
| 4   | Share of the top 20 statements of the Ledgerline workload that get parameter bindings (with provenance)     | reported as counts     | see `docs/benchmarks` (L3.1) |
| 5   | Statements sent to the source database that are not read-only                                               | 0                      | enforced by test (L3.0-L3.4) |
| 6   | Time from connecting to the first verified fix on the demo database, using documented commands only         | to be measured         | not measured yet             |

## Event taxonomy

Typed in `src/product/events.ts` (nothing is sent yet; sinks arrive in L3.11). Events carry ids, hashes and classes only, never query text, literals, identifiers or plan text. `fix_rejected` and `fix_reverted` carry a reason class, not free text. A test rejects any event with a field named like query text.

| Event                   | Meaning                                              | Fields besides ids                                                     |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `investigation_started` | a user started an investigation                      | `statementCount`, `mode` (full or sampled shadow)                      |
| `slow_query_opened`     | the user opened one slow statement                   | `queryHash`, `rank`                                                    |
| `candidate_viewed`      | the user opened a proposed fix                       | `candidateId`, `candidateKind`, `verdictClass`                         |
| `fix_accepted`          | the user accepted a fix (exports the migration only) | `candidateId`, `verdictClass`                                          |
| `fix_rejected`          | the user rejected a fix                              | `candidateId`, `reasonClass`                                           |
| `fix_reverted`          | the user reports a fix was rolled back               | `candidateId`, `reasonClass`                                           |
| `thumbs`                | thumbs up or down on a result                        | `target`, `targetId`, `value`                                          |
| `state_shown`           | an unusual state was shown                           | `state` (rate_limited, quota_exhausted, no_problems, fix_did_not_help) |
