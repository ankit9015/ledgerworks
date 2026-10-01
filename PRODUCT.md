# Ledgerworks: PRODUCT.md

This file covers Ledgerline (the Phase 1 package). Ledgerlens and Ledgerlatch sections are added in their own phases.

## Persona

**Dana, a developer building an AI product.** Dana is a full-stack or backend engineer at a small team shipping an AI-powered app. The app calls LLMs on behalf of paying customers. Dana is comfortable with TypeScript and Postgres, but does not want to spend weeks building billing-adjacent plumbing.

## Problem

Dana needs per-customer usage metering, a credit balance that cannot be overdrawn, and background jobs that run reliably, without writing and hardening all three from scratch. Hand-rolled versions tend to fail in the same ways: customers see each other's data, concurrent requests double-spend credits, jobs run twice or get lost, and usage queries slow down as event tables grow.

## Goals

1. Provide a multi-tenant backend with a usage ledger, credit accounting and a job queue behind one small HTTP API.
2. Enforce tenant isolation in the database itself (row-level security), not only in application code.
3. Keep credit and job operations correct under heavy concurrency.
4. Stay fast on a large events table, and show the evidence (benchmarks, query plans).
5. Be runnable by a new developer with a few documented commands.

## Non-goals

1. **Not a payment processor.** No card handling, invoices, taxes or subscriptions. Credits are an internal accounting unit.
2. **Not a general workflow engine.** The job queue handles retries, backoff and dead-lettering, not DAGs, schedules across services or long-running sagas.
3. **Not a distributed or sharded database.** One Postgres instance. Scaling past it is out of scope.
4. **Not a hosted SaaS.** No billing for Ledgerline itself, no multi-region deployment, no SSO.

## Success metrics

Targets are set before measuring. Results are filled in only from real runs and published in `docs/benchmarks/`.

| #   | Metric                                                                                                                          | Target                                      | Result                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cross-tenant reads or writes found by the isolation test matrix (roles x tables x operations)                                   | 0                                           | not yet measured                                                                                                                                   |
| 2   | Credit correctness under 50 parallel workers and 10,000 debits: overdrafts, double-spends, and ledger-sum vs balance mismatches | 0 of each                                   | not yet measured                                                                                                                                   |
| 3   | Job queue with 50 workers and 10,000 jobs: jobs executed twice or lost                                                          | 0 of each                                   | not yet measured                                                                                                                                   |
| 4   | p95 latency of usage read (tenant + date range) at 10M seeded events                                                            | target to be agreed (baseline now measured) | Baseline, unoptimized, 10M synthetic events, 2 iterations/s: huge tenant p95 162.5 ms, small tenant p95 22.0 ms. See `docs/benchmarks/baseline.md` |
| 5   | Time for a fresh clone to reach a running demo using only documented commands                                                   | under 10 minutes                            | not yet measured                                                                                                                                   |
