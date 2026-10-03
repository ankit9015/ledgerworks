/**
 * Shadow database CLI.
 *
 *   SHADOW_SOURCE_URL=postgres://reader:...@host:5432/db pnpm --filter @ledgerworks/core shadow create --mode full
 *   pnpm --filter @ledgerworks/core shadow create --mode sampled --root public.tenants --ratio 0.1 --seed 7
 *   pnpm --filter @ledgerworks/core shadow status [runId]
 *   pnpm --filter @ledgerworks/core shadow url <runId>          (prints the connection string, with its password)
 *   pnpm --filter @ledgerworks/core shadow destroy <runId>
 *   pnpm --filter @ledgerworks/core shadow cleanup --older-than 24h [--dry-run]
 *
 * The source URL is read from the environment, never from argv, so it does not show up in process
 * listings or shell history. `create` leaves the shadow running; destroy or clean it up afterwards.
 */
import { parseArgs } from 'node:util';
import { cleanupShadows, destroyShadow, shadowStatus } from './lifecycle.js';
import { attachShadow, createShadow } from './runner.js';

function parseAge(s: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(s);
  if (!m) throw new Error(`bad age "${s}" (use 30m, 24h, 7d)`);
  return (
    Number(m[1]) *
    { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd']
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      mode: { type: 'string', default: 'full' },
      root: { type: 'string' },
      ratio: { type: 'string' },
      seed: { type: 'string' },
      cpus: { type: 'string' },
      'memory-mib': { type: 'string' },
      'source-container': { type: 'string' },
      'allow-writable-source': { type: 'boolean', default: false },
      'older-than': { type: 'string', default: '24h' },
      'dry-run': { type: 'boolean', default: false },
    },
  });

  switch (command) {
    case 'create': {
      const sourceUrl = process.env.SHADOW_SOURCE_URL;
      if (!sourceUrl)
        throw new Error('set SHADOW_SOURCE_URL to the read-only source connection string');
      const mode = values.mode === 'sampled' ? 'sampled' : 'full';
      const h = await createShadow({
        sourceUrl,
        mode,
        sampling:
          mode === 'sampled'
            ? {
                rootTable:
                  values.root ??
                  (() => {
                    throw new Error('--root is required for sampled mode');
                  })(),
                ratio: Number(values.ratio ?? 0.1),
                ...(values.seed ? { seed: Number(values.seed) } : {}),
              }
            : undefined,
        limits: {
          ...(values.cpus ? { cpus: Number(values.cpus) } : {}),
          ...(values['memory-mib'] ? { memoryMiB: Number(values['memory-mib']) } : {}),
        },
        sourceContainer: values['source-container'],
        allowWritableSource: values['allow-writable-source'],
        log: (m) => console.error(m),
      });
      console.log(
        `shadow ${h.runId} is running (container ${h.containerName}, volume ${h.volumeName}, port ${h.port})`,
      );
      console.log(`manifest: ${h.manifestPath}`);
      console.log(
        `total ${(h.manifest.totalDurationMs / 1000).toFixed(1)} s; sampled: ${h.manifest.scaling.sampled}`,
      );
      console.log(`destroy with: shadow destroy ${h.runId}`);
      break;
    }
    case 'status': {
      const rows = await shadowStatus(positionals[0]);
      if (!rows.length) console.log('no shadow resources');
      for (const r of rows) {
        console.log(
          `${r.kind.padEnd(9)} ${r.name.padEnd(32)} run ${r.runId}  created ${r.createdAt.toISOString()}  ${r.state ?? ''}`,
        );
      }
      break;
    }
    case 'url': {
      if (!positionals[0]) throw new Error('usage: shadow url <runId>');
      console.log((await attachShadow(positionals[0])).connectionString());
      break;
    }
    case 'destroy': {
      if (!positionals[0]) throw new Error('usage: shadow destroy <runId>');
      const removed = await destroyShadow(positionals[0]);
      console.log(
        removed.length
          ? removed.map((r) => `removed ${r.kind} ${r.name}`).join('\n')
          : 'nothing to remove',
      );
      break;
    }
    case 'cleanup': {
      const r = await cleanupShadows({
        olderThanMs: parseAge(values['older-than']!),
        dryRun: values['dry-run'],
      });
      const verb = r.dryRun ? 'would remove' : 'removed';
      console.log(
        r.selected.length
          ? r.selected
              .map((x) => `${verb} ${x.kind} ${x.name} (created ${x.createdAt.toISOString()})`)
              .join('\n')
          : 'nothing to clean up',
      );
      console.log(`kept ${r.kept.length} younger resource(s)`);
      break;
    }
    default:
      console.error(
        'commands: create | status [runId] | url <runId> | destroy <runId> | cleanup --older-than 24h [--dry-run]',
      );
      process.exit(2);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
