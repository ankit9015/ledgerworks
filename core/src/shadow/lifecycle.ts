import { docker } from './docker.js';

/** Every container and volume the runner creates carries these. Cleanup touches nothing without them. */
export const SHADOW_LABEL = 'ledgerworks.shadow';
export const RUN_ID_LABEL = 'ledgerworks.shadow.run-id';
export const CREATED_AT_LABEL = 'ledgerworks.shadow.created-at';
export const MODE_LABEL = 'ledgerworks.shadow.mode';
export const NAME_PREFIX = 'lw-shadow-';

export function containerNameFor(runId: string): string {
  return `${NAME_PREFIX}${runId.slice(0, 8)}`;
}
export function volumeNameFor(runId: string): string {
  return `${NAME_PREFIX}${runId.slice(0, 8)}-data`;
}

export function shadowLabels(runId: string, mode: string, createdAt: Date): Record<string, string> {
  return {
    [SHADOW_LABEL]: 'true',
    [RUN_ID_LABEL]: runId,
    [CREATED_AT_LABEL]: createdAt.toISOString(),
    [MODE_LABEL]: mode,
  };
}

export function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
}

export interface ShadowResource {
  kind: 'container' | 'volume';
  name: string;
  runId: string;
  createdAt: Date;
  state?: string;
}

interface InspectedContainer {
  Name: string;
  Created: string;
  Config: { Labels: Record<string, string> | null };
  State: { Status: string };
}
interface InspectedVolume {
  Name: string;
  CreatedAt: string;
  Labels: Record<string, string> | null;
}

function createdAtOf(labels: Record<string, string>, fallback: string): Date {
  const fromLabel = labels[CREATED_AT_LABEL];
  const d = new Date(fromLabel ?? fallback);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

/**
 * Every container and volume that carries the shadow label AND the name prefix. A resource with the
 * label but another name, or the prefix but no label, is never listed.
 */
export async function listShadowResources(): Promise<ShadowResource[]> {
  const out: ShadowResource[] = [];
  const ids = (await docker(['ps', '-a', '-q', '--filter', `label=${SHADOW_LABEL}=true`])).stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length) {
    const inspected = JSON.parse(
      (await docker(['inspect', ...ids])).stdout,
    ) as InspectedContainer[];
    for (const c of inspected) {
      const labels = c.Config.Labels ?? {};
      const name = c.Name.replace(/^\//, '');
      if (labels[SHADOW_LABEL] !== 'true' || !name.startsWith(NAME_PREFIX)) continue;
      out.push({
        kind: 'container',
        name,
        runId: labels[RUN_ID_LABEL] ?? name,
        createdAt: createdAtOf(labels, c.Created),
        state: c.State.Status,
      });
    }
  }
  const vols = (
    await docker(['volume', 'ls', '-q', '--filter', `label=${SHADOW_LABEL}=true`])
  ).stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (vols.length) {
    const inspected = JSON.parse(
      (await docker(['volume', 'inspect', ...vols])).stdout,
    ) as InspectedVolume[];
    for (const v of inspected) {
      const labels = v.Labels ?? {};
      if (labels[SHADOW_LABEL] !== 'true' || !v.Name.startsWith(NAME_PREFIX)) continue;
      out.push({
        kind: 'volume',
        name: v.Name,
        runId: labels[RUN_ID_LABEL] ?? v.Name,
        createdAt: createdAtOf(labels, v.CreatedAt),
      });
    }
  }
  return out;
}

/** Resources (containers and volumes) of one run. */
export async function shadowStatus(runId?: string): Promise<ShadowResource[]> {
  const all = await listShadowResources();
  return runId ? all.filter((r) => r.runId === runId) : all;
}

async function removeResource(r: ShadowResource): Promise<void> {
  if (r.kind === 'container') {
    await docker(['rm', '-f', '-v', r.name]);
  } else {
    // A volume can still be "in use" for a moment after its container is removed.
    for (let i = 0; ; i++) {
      const res = await docker(['volume', 'rm', '-f', r.name], { allowFail: true });
      if (res.code === 0) return;
      if (i >= 5) throw new Error(`could not remove volume ${r.name}: ${res.stderr.trim()}`);
      await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
    }
  }
}

/** Removes the container(s) and volume(s) of one run, labelled resources only. */
export async function destroyShadow(runId: string): Promise<ShadowResource[]> {
  const mine = await shadowStatus(runId);
  // containers first, then volumes
  const ordered = [
    ...mine.filter((r) => r.kind === 'container'),
    ...mine.filter((r) => r.kind === 'volume'),
  ];
  for (const r of ordered) await removeResource(r);
  return ordered;
}

export interface CleanupResult {
  dryRun: boolean;
  olderThanMs: number;
  /** removed, or (dry run) would be removed */
  selected: ShadowResource[];
  /** labelled resources that are younger than the age and were left alone */
  kept: ShadowResource[];
}

/**
 * Removes shadow containers and volumes older than `olderThanMs`. Only resources with the shadow
 * label and the name prefix are considered. With `dryRun` nothing is removed.
 */
export async function cleanupShadows(o: {
  olderThanMs: number;
  dryRun?: boolean;
  now?: Date;
}): Promise<CleanupResult> {
  const now = (o.now ?? new Date()).getTime();
  const all = await listShadowResources();
  const selected = all.filter((r) => now - r.createdAt.getTime() >= o.olderThanMs);
  const kept = all.filter((r) => !selected.includes(r));
  if (!o.dryRun) {
    const ordered = [
      ...selected.filter((r) => r.kind === 'container'),
      ...selected.filter((r) => r.kind === 'volume'),
    ];
    for (const r of ordered) await removeResource(r);
  }
  return { dryRun: o.dryRun ?? false, olderThanMs: o.olderThanMs, selected, kept };
}
