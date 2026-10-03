# @ledgerworks/core

The shared engine. Everything here is generic: it works against any Postgres 16 database, Ledgerline is the first test subject.

| Part                 | Status | What it is                                                                                                        |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/shadow/` (C2.1) | done   | clones a database (full or sampled) into a throwaway, labelled Postgres container; the only place experiments run |

## Shadow database runner (C2.1)

```ts
import { createShadow, withShadow, assertShadow } from '@ledgerworks/core';

// sourceUrl must be a READ-ONLY role (see below). Teardown always runs.
await withShadow({ sourceUrl: process.env.SHADOW_SOURCE_URL!, mode: 'full' }, async (shadow) => {
  const db = await shadow.connect(); // superuser of the shadow only
  // ... experiments ...
  console.log(shadow.manifest.scaling); // sampled? ratios?
});
```

### Safety, in one place

1. **The source role must not be able to write.** `provisionReaderRole(adminUrl, ...)` (run once by a human) creates a role with `pg_read_all_data`, `BYPASSRLS` (needed to copy tables with `FORCE ROW LEVEL SECURITY`; without it the copy would silently miss rows) and `default_transaction_read_only = on`. `createShadow` runs `checkSourceReadOnly` first: privilege inventory plus a rolled-back `CREATE SCHEMA` and no-row `DELETE` with the session switched to read-write. A role that can write is refused (`SourceWritableError`) unless `allowWritableSource: true`, which is logged loudly and recorded in the manifest.
2. Every source session is read-only (server-enforced at connect), has a statement timeout, a lock timeout and an identifiable `application_name`, and only sends statements that pass an allow-list. The runner never sends DDL or DML to the source. See DECISIONS.md D31.
3. **No resource competition:** the shadow has its own CPU, memory, swap, pids and shm limits and its own volume, and the runner refuses to start when the Docker host cannot hold the shadow **and** a reserve for the source. Defaults: shadow 2 CPUs / 3 GiB, reserve 2 CPUs / 2 GiB.
   - **Verified:** the full clone of the 10M-row Ledgerline database at 2 CPUs / 3 GiB, on a Docker host with 8 CPUs / 9.6 GiB, with the source at 2 CPUs / 2 GiB: 97.8 s, source not harmed (`docs/benchmarks/shadow-clone.md`).
   - **Not verified:** anything smaller. The shadow's cgroup peak reached its 3 GiB limit (page cache), the sampled working set peaked at 1.7 GiB. Try less than 2 GiB at your own risk. I/O is shared on one-disk hosts and cannot be capped here; `maxSourceMBps` caps the read rate from the source.
4. Every shadow is marked: database setting `ledgerworks.shadow_run_id`, marker table `ledgerworks_meta.shadow_marker` with the manifest, container and volume labels `ledgerworks.shadow=true` and a run id. `assertShadow(client)` checks all of it; the measurement harness (C2.2) calls it before doing anything.

### Modes and the manifest

- `mode: 'full'`: every table has the source's row count (verified).
- `mode: 'sampled'` with `sampling: { rootTable, ratio, seed, uncovered, isolated, fullTables }`: the root table is sampled by a deterministic hash, children follow their foreign keys, referenced parents keep what is referenced (D32). **The ratio is a ratio of root rows, not of data**: 8.8% of Ledgerline's tenants gave 2.9% of its usage events.
- The manifest (`ShadowManifestSchema`, `manifestVersion` 1, also stored inside the shadow) records source database and server version, mode and rule, per-table source rows, shadow rows, ratio and why, container limits and host, image id and versions, extensions, roles, planner settings side by side, copy parameters, the duration of every stage, peak memory (sampled and cgroup), the source container's health before and after, and warnings. It never contains a credential.
- **Any timing taken on a sampled shadow must be reported as measured on a sample.** `manifest.scaling.sampled`, `totalRowRatio` and `largestTableRatio` are there for that.

### Lifecycle

```
pnpm --filter @ledgerworks/core shadow create --mode full              # source URL from $SHADOW_SOURCE_URL
pnpm --filter @ledgerworks/core shadow create --mode sampled --root public.tenants --ratio 0.1 --seed 7
pnpm --filter @ledgerworks/core shadow status [runId]
pnpm --filter @ledgerworks/core shadow url <runId>                      # connection string, with password
pnpm --filter @ledgerworks/core shadow destroy <runId>
pnpm --filter @ledgerworks/core shadow cleanup --older-than 24h --dry-run
```

`cleanup` considers only containers and volumes that carry the shadow label **and** the `lw-shadow-` name prefix. `createShadow` removes everything it made when it fails (also when the container is killed halfway), and `withShadow` tears down in a `finally`.

### Tests

- `pnpm test` runs `src/shadow/shadow.small.test.ts` (real Docker and Postgres, about 1 minute): clone of the small Ledgerline demo database (created on first use as `ledgerline_demo`), schema equality, counts and checksums, sampled integrity for every foreign key, source-unchanged proof, read-only role and refusal tests, failure and orphan cleanup, marker. Needs Docker; the first run builds the shadow image.
- `pnpm test:shadow-full` clones the 10M-row benchmark database (needs `pnpm seed --yes` first), once in full and once sampled, and writes timestamped raw files to `docs/benchmarks/raw/`. Minutes; not part of `pnpm test` or CI.
