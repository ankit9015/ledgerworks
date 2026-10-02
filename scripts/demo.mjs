// One-command demo: starts Postgres (Docker), migrates, loads the small demo seed, then runs the
// API (:3000) and the admin UI (:5173) until Ctrl-C.
//
//   pnpm demo
//
// The demo seed is synthetic and takes about a second (the 10M-row benchmark seed is `pnpm seed --yes`
// and takes minutes). Raw API keys go to .seed/keys-demo.json (gitignored); the key of the "small"
// demo tenant is printed once so you can paste it into the UI. It is a development key for synthetic
// data on your own machine.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`\nFailed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
};

run('docker', ['compose', 'up', '-d', '--wait', 'postgres']);
run('pnpm', ['migrate']);
run('pnpm', ['seed:demo']);

const keys = JSON.parse(readFileSync('.seed/keys-demo.json', 'utf8')).tenants;
const children = [
  spawn('pnpm', ['--filter', '@ledgerworks/ledgerline', 'dev'], { stdio: 'inherit', shell: true }),
  spawn('pnpm', ['--filter', '@ledgerworks/ledgerline-ui', 'dev'], {
    stdio: 'inherit',
    shell: true,
  }),
];

const waitFor = async (url) => {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} did not come up`);
};
await waitFor('http://localhost:3000/health');
await waitFor('http://localhost:5173/');

const small = keys.find((t) => t.size === 'small');
console.log(`
============================================================
 Ledgerline demo is running.
   Admin UI : http://localhost:5173
   API      : http://localhost:3000   (try: GET /health)
 Sign in to the UI with this synthetic demo key (small tenant):
   ${small.apiKey}
 The huge demo tenant's key is in .seed/keys-demo.json.
 Press Ctrl-C to stop the API and the UI (Postgres keeps running: docker compose down).
============================================================
`);
const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
