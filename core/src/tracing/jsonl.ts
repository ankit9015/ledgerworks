import { appendFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { RunTrace } from '../agent/types.js';
import type { TraceLine } from './schema.js';
import { prepareForExport, type ExportPolicy, type TraceSink } from './sinks.js';

export interface JsonlFileSinkOptions extends ExportPolicy {
  /** default: $LEDGERWORKS_TRACE_DIR or ./.ledgerworks/traces (gitignored) */
  dir?: string;
  fileName?: string;
  /** the file is rotated before it would grow beyond this. Default 5 MiB. */
  maxFileBytes?: number;
  /** files kept, the current one included; the oldest rotated files beyond this are deleted. Default 10. */
  maxFiles?: number;
}

/**
 * The default sink: one JSON line per finished run, appended to a local file under a gitignored
 * directory. The file is size-capped: when the next line would exceed `maxFileBytes` the file is
 * renamed to runs.<time>.jsonl and a new one starts, and only `maxFiles` files are kept. Lines are
 * written one at a time, in order, even when runs finish concurrently.
 */
export class JsonlFileSink implements TraceSink {
  readonly name = 'jsonl';
  readonly dir: string;
  readonly file: string;
  private base: string;
  private maxBytes: number;
  private maxFiles: number;
  private queue: Promise<void> = Promise.resolve();
  private rotations = 0;

  constructor(private o: JsonlFileSinkOptions = {}) {
    this.dir =
      o.dir ??
      process.env.LEDGERWORKS_TRACE_DIR ??
      path.join(process.cwd(), '.ledgerworks', 'traces');
    this.base = o.fileName ?? 'runs';
    this.file = path.join(this.dir, `${this.base}.jsonl`);
    this.maxBytes = o.maxFileBytes ?? 5 * 1024 * 1024;
    this.maxFiles = Math.max(1, o.maxFiles ?? 10);
  }

  write(trace: RunTrace): Promise<void> {
    const line: TraceLine = {
      v: 1,
      kind: 'agent-run',
      exportedAt: new Date().toISOString(),
      trace: prepareForExport(trace, this.o),
    };
    const text = JSON.stringify(line) + '\n';
    const job = this.queue.then(() => this.append(text));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async append(text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const size = await stat(this.file).then(
      (s) => s.size,
      () => 0,
    );
    if (size > 0 && size + Buffer.byteLength(text) > this.maxBytes) await this.rotate();
    await appendFile(this.file, text, { mode: 0o600 });
  }

  private async rotate(): Promise<void> {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
    await rename(this.file, path.join(this.dir, `${this.base}.${stamp}-${++this.rotations}.jsonl`));
    const rotated = (await readdir(this.dir))
      .filter(
        (f) => f.startsWith(`${this.base}.`) && f.endsWith('.jsonl') && f !== `${this.base}.jsonl`,
      )
      .sort();
    const excess = rotated.length - (this.maxFiles - 1);
    for (const f of rotated.slice(0, Math.max(0, excess)))
      await unlink(path.join(this.dir, f)).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.queue;
  }
}
