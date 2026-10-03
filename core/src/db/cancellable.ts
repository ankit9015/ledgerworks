import pg from 'pg';

/** A way to open a database connection; tools receive one from their context (C2.8). */
export type ConnectionFactory = () => Promise<pg.Client>;

export class ToolAbortedError extends Error {
  constructor(message = 'the tool was cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Cancels whatever `pid` is running on the server, from a second short connection:
 * `SELECT pg_cancel_backend(pid)`. The same database user may cancel its own sessions, so no
 * special privilege is needed. Never throws; returns whether the server accepted the request.
 */
export async function cancelBackend(pid: number, factory: ConnectionFactory): Promise<boolean> {
  let c: pg.Client | undefined;
  try {
    c = await factory();
    const r = await c.query<{ ok: boolean }>('SELECT pg_cancel_backend($1) AS ok', [pid]);
    return r.rows[0]?.ok === true;
  } catch {
    return false;
  } finally {
    await c?.end().catch(() => undefined);
  }
}

export interface CancellableOptions {
  /** server-side limit for each statement, ms */
  statementTimeoutMs?: number;
  /** after a cancel request, how long to wait for the query to stop before the connection is dropped. Default 1,000. */
  hardStopAfterMs?: number;
  /** connection factory for the cancel request; default: the same factory */
  cancelFactory?: ConnectionFactory;
}

/**
 * The helper every database tool should use. It opens a connection, runs `fn` with it, and:
 *  - when `signal` aborts (tool timeout or run cancellation) it CANCELS the running query on the
 *    server (pg_cancel_backend from a second connection), and if the query has not stopped after
 *    `hardStopAfterMs` it drops the connection, which makes the server abandon the session;
 *  - always releases the connection (`end`, or destroys it if that hangs);
 *  - throws a ToolAbortedError (name "AbortError") when it was cancelled, instead of leaking
 *    the server's "canceling statement" error.
 * So when the tool's promise settles, nothing is left running on the server for that tool.
 */
export async function withCancellableClient<T>(
  factory: ConnectionFactory,
  signal: AbortSignal,
  fn: (client: pg.Client) => Promise<T>,
  o: CancellableOptions = {},
): Promise<T> {
  if (signal.aborted) throw new ToolAbortedError();
  const client = await factory();
  client.on('error', () => undefined);
  let aborted = false;
  let hardStop: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    aborted = true;
    void (async () => {
      try {
        const pid = (client as unknown as { processID?: number }).processID;
        if (pid) await cancelBackend(pid, o.cancelFactory ?? factory);
      } finally {
        hardStop = setTimeout(() => {
          (
            client as unknown as { connection?: { stream?: { destroy(): void } } }
          ).connection?.stream?.destroy();
        }, o.hardStopAfterMs ?? 1000);
        hardStop.unref?.();
      }
    })();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (o.statementTimeoutMs !== undefined) {
      await client.query(
        `SET statement_timeout = ${Math.max(1, Math.floor(o.statementTimeoutMs))}`,
      );
    }
    if (signal.aborted) onAbort();
    return await fn(client);
  } catch (e) {
    if (aborted || signal.aborted) throw new ToolAbortedError();
    throw e;
  } finally {
    signal.removeEventListener('abort', onAbort);
    clearTimeout(hardStop);
    await Promise.race([
      client.end().catch(() => undefined),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    (
      client as unknown as { connection?: { stream?: { destroy(): void } } }
    ).connection?.stream?.destroy();
  }
}
