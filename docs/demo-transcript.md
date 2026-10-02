# Demo from a fresh clone: the transcript

What was actually run, on 2026-10-03, to check that the README steps reach a working demo from a clean directory. The repository was cloned from the committed state (`git clone` into an empty directory, so no `node_modules`, no `.seed`, no database), **with the original Postgres stack stopped and the clone using its own new Docker volume** (the compose project name follows the directory name), so the database was brand new. Docker Desktop, Node 22.13.1 and pnpm were already installed; the pnpm package cache was warm, so the install time is not representative of a cold network. Output trimmed: log lines of the API are omitted and the demo key is redacted here (it is a synthetic development key for a throwaway database).

## 1. Clone and install

```
$ git clone <repo> ledgerworks-fresh && cd ledgerworks-fresh
$ ls .seed
ls: cannot access '.seed': No such file or directory
$ pnpm install --frozen-lockfile
...
Scope: all 8 workspace projects
Lockfile is up to date, resolution step is skipped
Progress: resolved 1, reused 0, downloaded 0, added 0
Packages: +313
++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
Progress: resolved 313, reused 298, downloaded 0, added 0
Progress: resolved 313, reused 313, downloaded 0, added 242
Progress: resolved 313, reused 313, downloaded 0, added 313, done
.../esbuild@0.21.5/node_modules/esbuild postinstall$ node install.js
.../esbuild@0.21.5/node_modules/esbuild postinstall: Done
devDependencies:
+ @eslint/js 9.39.5
+ @playwright/test 1.63.0
+ eslint 9.39.5
+ prettier 3.9.9
+ typescript 5.9.3
+ typescript-eslint 8.71.0
+ vitest 2.1.9
Done in 4.6s
real	0m4.879s
user	0m0.000s
sys	0m0.030s
```

## 2. `pnpm demo`

```

> ledgerworks@ demo D:\tmp-fresh\ledgerworks-fresh
> node scripts/demo.mjs


$ docker compose up -d --wait postgres
 Network ledgerworks-fresh_default  Creating
 Network ledgerworks-fresh_default  Created
 Volume "ledgerworks-fresh_pgdata"  Creating
 Volume "ledgerworks-fresh_pgdata"  Created
 Container ledgerworks-postgres  Creating
 Container ledgerworks-postgres  Created
 Container ledgerworks-postgres  Starting
 Container ledgerworks-postgres  Started
 Container ledgerworks-postgres  Waiting
 Container ledgerworks-postgres  Healthy

$ pnpm migrate

> ledgerworks@ migrate D:\tmp-fresh\ledgerworks-fresh
> pnpm --filter @ledgerworks/ledgerline migrate


> @ledgerworks/ledgerline@0.0.0 migrate D:\tmp-fresh\ledgerworks-fresh\ledgerline
> tsx src/db/migrate-cli.ts

migrations applied: 0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009, 0010, 0011; already applied: (none)

$ pnpm seed:demo

> ledgerworks@ seed:demo D:\tmp-fresh\ledgerworks-fresh
> pnpm --filter @ledgerworks/ledgerline seed:demo


> @ledgerworks/ledgerline@0.0.0 seed:demo D:\tmp-fresh\ledgerworks-fresh\ledgerline
> tsx src/seed/demo-seed.ts

demo seed done: 2 tenants; raw keys written to .seed/keys-demo.json (not printed)

> @ledgerworks/ledgerline@0.0.0 dev D:\tmp-fresh\ledgerworks-fresh\ledgerline
> tsx src/server.ts


> @ledgerworks/ledgerline-ui@0.0.0 dev D:\tmp-fresh\ledgerworks-fresh\ledgerline\ui
> vite


  VITE v8.3.2  ready in 536 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose

============================================================
 Ledgerline demo is running.
   Admin UI : http://localhost:5173
   API      : http://localhost:3000   (try: GET /health)
 Sign in to the UI with this synthetic demo key (small tenant):
   lk_xxxxxxxx_(synthetic demo key, redacted here)
 The huge demo tenant's key is in .seed/keys-demo.json.
 Press Ctrl-C to stop the API and the UI (Postgres keeps running: docker compose down).
============================================================

D:\tmp-fresh\ledgerworks-fresh\ledgerline:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @ledgerworks/ledgerline@0.0.0 dev: `tsx src/server.ts`
Exit status 4294967295
D:\tmp-fresh\ledgerworks-fresh\ledgerline\ui:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @ledgerworks/ledgerline-ui@0.0.0 dev: `vite`
Exit status 4294967295
```

## 3. The UI works against it

With the demo running, in the same clone:

```
$ curl localhost:3000/health
{"status":"ok","db":"ok"}
$ curl localhost:5173/api/health        # through the UI's same-origin proxy
{"status":"ok","db":"ok"}
$ E2E_KEYS_FILE=.seed/keys-demo.json pnpm e2e
Running 4 tests using 1 worker
  ok 1 the panels show real numbers for the huge tenant that match a direct API call (1.2s)
  ok 2 the panels show real numbers for the small tenant that match a direct API call (829ms)
  ok 3 a tenant key never shows another tenant data in the UI (small and huge, both directions) (1.4s)
  ok 4 a wrong key shows the unauthorized state in every panel, and the key is not kept anywhere (877ms)
  4 passed (6.0s)
```

The fourth manual step of the README ("open the UI") is what these Playwright tests do in a real browser: they type the key, and compare each number on screen with a direct API call.

## What I did not verify

- A cold start with no pnpm cache and no pulled `postgres:16` image (both were already present).
- Windows only: Linux and macOS were not run (CI uses Linux for the tests, but the demo script itself was only run here).
