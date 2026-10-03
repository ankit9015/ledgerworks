/** Real Postgres: a cancelled or timed-out tool really stops its query on the server. */
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, runAgent } from '../agent/index.js';
import { FakeProvider } from '../llm/fake.js';
import { ADMIN_URL } from '../shadow/testing/helpers.js';
import { ToolAbortedError, cancelBackend, withCancellableClient } from './cancellable.js';

const tag = `lw-cancel-${Math.random().toString(36).slice(2, 8)}`;
const factory = (name: string) => async (): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: ADMIN_URL, application_name: name });
  await c.connect();
  return c;
};
const admin = new pg.Client({ connectionString: ADMIN_URL });
const ready = admin.connect();
afterAll(async () => {
  await ready;
  await admin.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE $1',
    [`${tag}%`],
  );
  await admin.end();
});

/** sessions of this test that are running a query right now, and sessions that exist at all */
async function sessions(name: string): Promise<{ active: number; total: number }> {
  await ready;
  const r = await admin.query<{ active: string; total: string }>(
    `SELECT count(*) FILTER (WHERE state = 'active')::text AS active, count(*)::text AS total
       FROM pg_stat_activity WHERE application_name = $1`,
    [name],
  );
  return { active: Number(r.rows[0]!.active), total: Number(r.rows[0]!.total) };
}
const until = async (cond: () => Promise<boolean>, ms = 3000): Promise<boolean> => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};

describe('withCancellableClient', () => {
  it('abort cancels a running pg_sleep on the SERVER and releases the connection', async () => {
    const name = `${tag}-a`;
    const ac = new AbortController();
    const p = withCancellableClient(factory(name), ac.signal, (c) =>
      c.query('SELECT pg_sleep(30)'),
    ).then(
      () => 'finished',
      (e: unknown) => e,
    );
    expect(await until(async () => (await sessions(name)).active === 1)).toBe(true); // it is really running on the server
    const t0 = Date.now();
    ac.abort();
    const e = await p;
    expect(e).toBeInstanceOf(ToolAbortedError);
    expect((e as Error).name).toBe('AbortError');
    expect(Date.now() - t0).toBeLessThan(1500); // stopped long before the 30 s
    expect(await sessions(name)).toEqual({ active: 0, total: 0 }); // no query, and the connection is gone
  });

  it('an already-aborted signal never opens a connection', async () => {
    const ac = new AbortController();
    ac.abort();
    let opened = 0;
    await expect(
      withCancellableClient(
        async () => (opened++, factory(`${tag}-b`)()),
        ac.signal,
        async () => 1,
      ),
    ).rejects.toBeInstanceOf(ToolAbortedError);
    expect(opened).toBe(0);
  });

  it('releases the connection after success and after an ordinary SQL error, and passes the error through', async () => {
    const name = `${tag}-c`;
    const ac = new AbortController();
    expect(
      await withCancellableClient(
        factory(name),
        ac.signal,
        async (c) => (await c.query('SELECT 42 AS n')).rows[0].n,
      ),
    ).toBe(42);
    await expect(
      withCancellableClient(factory(name), ac.signal, (c) =>
        c.query('SELECT * FROM table_that_does_not_exist'),
      ),
    ).rejects.toMatchObject({ code: '42P01' });
    expect(await sessions(name)).toEqual({ active: 0, total: 0 });
  });

  it('the statement timeout option is enforced by the server', async () => {
    const name = `${tag}-d`;
    const e = await withCancellableClient(
      factory(name),
      new AbortController().signal,
      (c) => c.query('SELECT pg_sleep(10)'),
      { statementTimeoutMs: 200 },
    ).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect((e as { code?: string }).code).toBe('57014');
    expect(await sessions(name)).toEqual({ active: 0, total: 0 });
  });

  it('cancelBackend cancels another session and reports whether the server accepted', async () => {
    const name = `${tag}-e`;
    const victim = await factory(name)();
    const pid = (victim as unknown as { processID: number }).processID;
    const running = victim.query('SELECT pg_sleep(30)').then(
      () => 'finished',
      (e: { code?: string }) => e.code,
    );
    expect(await until(async () => (await sessions(name)).active === 1)).toBe(true);
    expect(await cancelBackend(pid, factory(`${tag}-e2`))).toBe(true);
    expect(await running).toBe('57014');
    await victim.end();
    expect(await cancelBackend(999999999, factory(`${tag}-e3`))).toBe(false);
  });
});

describe('the agent loop and database tools', () => {
  const sleepTool = (name: string, safe: boolean, seen: { settled: boolean }) =>
    defineTool({
      name: 'slow_query',
      description: 'runs a long query',
      parameters: z.object({}),
      execute: async (_a: unknown, ctx) => {
        try {
          if (safe)
            return await withCancellableClient(factory(name), ctx.signal, (c) =>
              c.query('SELECT pg_sleep(30)'),
            );
          const c = await factory(name)(); // a naive tool: ignores the signal
          return await c.query('SELECT pg_sleep(30)');
        } finally {
          seen.settled = true;
        }
      },
    });

  it('after a tool timeout the query is cancelled on the server; the loop leaves no background work', async () => {
    const name = `${tag}-f`;
    const seen = { settled: false };
    const p = new FakeProvider({
      script: [
        { type: 'tool_calls', calls: [{ name: 'slow_query', arguments: {} }] },
        { type: 'text', content: 'done' },
      ],
    });
    const t0 = Date.now();
    const r = await runAgent({
      provider: p,
      prompt: 'x',
      tools: [sleepTool(name, true, seen)],
      toolTimeoutMs: 300,
    });
    expect(Date.now() - t0).toBeLessThan(3000);
    const call = r.trace.steps[0]!.toolCalls[0]!;
    expect(call.outcome).toBe('timeout');
    expect(call.abandoned).toBeUndefined(); // the tool stopped within the grace period
    expect(seen.settled).toBe(true); // the tool's own promise is finished by the time the loop moves on
    // checked on the server, immediately after the run returned: nothing active, no connection left
    expect(await sessions(name)).toEqual({ active: 0, total: 0 });
    expect(r.finalAnswer).toBe('done');
  });

  it('run cancellation mid-query stops the query on the server too', async () => {
    const name = `${tag}-g`;
    const seen = { settled: false };
    const ac = new AbortController();
    const p = new FakeProvider({
      script: [
        { type: 'tool_calls', calls: [{ name: 'slow_query', arguments: {} }] },
        { type: 'text', content: 'never' },
      ],
    });
    const pending = runAgent({
      provider: p,
      prompt: 'x',
      tools: [sleepTool(name, true, seen)],
      signal: ac.signal,
    });
    expect(await until(async () => (await sessions(name)).active === 1)).toBe(true);
    ac.abort();
    const r = await pending;
    expect(r.stopReason).toBe('cancelled');
    expect(seen.settled).toBe(true);
    expect(await sessions(name)).toEqual({ active: 0, total: 0 });
  });

  it('CONTRAST: a tool that ignores its signal keeps running on the server, and the loop reports it as abandoned', async () => {
    const name = `${tag}-h`;
    const seen = { settled: false };
    const p = new FakeProvider({
      script: [
        { type: 'tool_calls', calls: [{ name: 'slow_query', arguments: {} }] },
        { type: 'text', content: 'done' },
      ],
    });
    const r = await runAgent({
      provider: p,
      prompt: 'x',
      tools: [sleepTool(name, false, seen)],
      toolTimeoutMs: 150,
      toolAbortGraceMs: 150,
    });
    const call = r.trace.steps[0]!.toolCalls[0]!;
    expect(call.outcome).toBe('timeout');
    expect(call.abandoned).toBe(true); // not hidden
    expect((await sessions(name)).active).toBe(1); // still running on the server
    await ready;
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1',
      [name],
    );
    expect(await until(async () => (await sessions(name)).total === 0)).toBe(true);
  });
});
