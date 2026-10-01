import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashApiKey } from '../src/keys.js';
import { adminPool, appPool } from './helpers.js';

const ADMIN_TOKEN = 'test-admin-token-123';

let admin: pg.Pool;
let app: pg.Pool;
let server: FastifyInstance;
const logLines: string[] = [];

interface Tenant {
  id: string;
  key: string;
  prefix: string;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const unique = () => Math.random().toString(36).slice(2, 10);

async function createTenant(name = `tenant-${unique()}`): Promise<Tenant> {
  const res = await server.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: { 'x-admin-token': ADMIN_TOKEN },
    payload: { name, ownerEmail: `${unique()}@api.test` },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { id: body.tenant.id, key: body.apiKey.key, prefix: body.apiKey.prefix };
}

async function ingest(t: Tenant, payload: Record<string, unknown>) {
  return server.inject({
    method: 'POST',
    url: '/v1/usage-events',
    headers: bearer(t.key),
    payload,
  });
}

function expectErrorShape(body: unknown, code: string): void {
  expect(body).toMatchObject({
    error: { code, message: expect.any(String), requestId: expect.any(String) },
  });
  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(/\bat .*\(.*:\d+:\d+\)/); // no stack frames
  expect(serialized).not.toMatch(/stack/i);
}

beforeAll(async () => {
  admin = adminPool();
  app = appPool();
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logLines.push(chunk.toString());
      cb();
    },
  });
  server = buildApp({
    db: app,
    logger: { level: 'trace', stream },
    tenantCreationToken: ADMIN_TOKEN,
  });
  await server.ready();
});

afterAll(async () => {
  await server.close();
  await admin.end();
  await app.end();
});

describe('GET /health', () => {
  it('happy path: ok and does not need auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('reports 503 without leaking details when the database is down', async () => {
    const broken = buildApp({
      db: {
        query: () => Promise.reject(new Error('secret connection string host=db.internal')),
        connect: () => Promise.reject(new Error('nope')),
      } as never,
    });
    const res = await broken.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('secret');
    await broken.close();
  });
});

describe('POST /v1/tenants', () => {
  it('happy path: returns the raw key once; only its hash is stored', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: { 'x-admin-token': ADMIN_TOKEN },
      payload: { name: 'Acme AI', ownerEmail: `owner-${unique()}@api.test` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { tenant, apiKey } = res.json();
    expect(tenant.name).toBe('Acme AI');
    expect(apiKey.key).toMatch(/^lk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(apiKey.key.startsWith(apiKey.prefix)).toBe(true);

    const rows = await admin.query('SELECT * FROM api_keys WHERE tenant_id = $1', [tenant.id]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].key_hash).toBe(hashApiKey(apiKey.key));
    expect(rows.rows[0].key_prefix).toBe(apiKey.prefix);
    expect(JSON.stringify(rows.rows[0])).not.toContain(apiKey.key); // raw key not stored anywhere

    const bal = await admin.query(
      'SELECT balance::int AS b FROM credit_balances WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(bal.rows[0].b).toBe(0);
  });

  it('issues a different key for every tenant', async () => {
    const [a, b] = [await createTenant(), await createTenant()];
    expect(a.key).not.toBe(b.key);
  });

  it('auth failure: rejects a missing or wrong admin token', async () => {
    for (const headers of [{}, { 'x-admin-token': 'wrong' }]) {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/tenants',
        headers,
        payload: { name: 'x', ownerEmail: 'x@api.test' },
      });
      expect(res.statusCode).toBe(401);
      expectErrorShape(res.json(), 'unauthorized');
    }
  });

  it('validates input', async () => {
    const bad: unknown[] = [
      {},
      { name: '', ownerEmail: 'a@b.test' },
      { name: 'x', ownerEmail: 'not-an-email' },
      { name: 'x', ownerEmail: 'a@b.test', isAdmin: true },
      { name: 123, ownerEmail: 'a@b.test' },
    ];
    for (const payload of bad) {
      const res = await server.inject({
        method: 'POST',
        url: '/v1/tenants',
        headers: { 'x-admin-token': ADMIN_TOKEN },
        payload: payload as object,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expectErrorShape(res.json(), 'validation_error');
    }
  });

  it('is open (no token) when no token is configured', async () => {
    const open = buildApp({ db: app });
    const res = await open.inject({
      method: 'POST',
      url: '/v1/tenants',
      payload: { name: 'open', ownerEmail: `${unique()}@api.test` },
    });
    expect(res.statusCode).toBe(201);
    await open.close();
  });
});

describe('authentication (all protected endpoints)', () => {
  const endpoints = [
    { method: 'POST', url: '/v1/usage-events', payload: { eventType: 'x', quantity: 1 } },
    { method: 'GET', url: '/v1/usage' },
    { method: 'GET', url: '/v1/credits/balance' },
  ] as const;

  it('rejects missing, malformed, wrong-scheme, unknown and revoked keys with an identical 401', async () => {
    const t = await createTenant();
    await admin.query('UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1', [t.id]);
    const unknownKey = `lk_${'0'.repeat(8)}_${'A'.repeat(43)}`;
    const headerSets: Record<string, string>[] = [
      {},
      { authorization: 'Bearer' },
      { authorization: 'Bearer not-a-key' },
      { authorization: `Basic ${t.key}` },
      { authorization: `bearer-ish ${t.key}` },
      { authorization: `Bearer ${unknownKey}` },
      { authorization: `Bearer ${t.key}` }, // revoked
    ];
    for (const ep of endpoints) {
      for (const headers of headerSets) {
        const res = await server.inject({
          ...ep,
          headers,
          payload: 'payload' in ep ? ep.payload : undefined,
        });
        expect(res.statusCode, `${ep.method} ${ep.url} ${JSON.stringify(headers)}`).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Bearer');
        expectErrorShape(res.json(), 'unauthorized');
      }
    }
  });

  it('checks the key before validating the body', async () => {
    const res = await server.inject({ method: 'POST', url: '/v1/usage-events', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/usage-events', () => {
  it('happy path: stores the event for the key owner', async () => {
    const t = await createTenant();
    const res = await ingest(t, {
      eventType: 'llm.tokens',
      quantity: 1234,
      occurredAt: '2026-03-10T12:00:00Z',
      metadata: { model: 'm1' },
    });
    expect(res.statusCode).toBe(201);
    const { id, occurredAt } = res.json();
    expect(occurredAt).toBe('2026-03-10T12:00:00.000000Z');
    const row = await admin.query('SELECT * FROM usage_events WHERE id = $1', [id]);
    expect(row.rows[0]).toMatchObject({
      tenant_id: t.id,
      event_type: 'llm.tokens',
      metadata: { model: 'm1' },
    });
    expect(Number(row.rows[0].quantity)).toBe(1234);
  });

  it('defaults occurredAt to now', async () => {
    const t = await createTenant();
    const res = await ingest(t, { eventType: 'x', quantity: 1 });
    expect(res.statusCode).toBe(201);
    expect(Math.abs(Date.now() - new Date(res.json().occurredAt).getTime())).toBeLessThan(60_000);
  });

  it('validates input and refuses to take a tenant from the body', async () => {
    const t = await createTenant();
    const bad: Record<string, unknown>[] = [
      {},
      { eventType: 'x' },
      { eventType: '', quantity: 1 },
      { eventType: 'x', quantity: -1 },
      { eventType: 'x', quantity: 1.5 },
      { eventType: 'x', quantity: 1, occurredAt: 'yesterday' },
      { eventType: 'x', quantity: 1, metadata: 'str' },
      { eventType: 'x', quantity: 1, tenant_id: '00000000-0000-0000-0000-000000000000' },
    ];
    for (const payload of bad) {
      const res = await ingest(t, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expectErrorShape(res.json(), 'validation_error');
    }
  });

  it('returns 422 for an event outside the partitioned date range', async () => {
    const t = await createTenant();
    const res = await ingest(t, {
      eventType: 'x',
      quantity: 1,
      occurredAt: '2035-01-01T00:00:00Z',
    });
    expect(res.statusCode).toBe(422);
    expectErrorShape(res.json(), 'occurred_at_out_of_range');
  });

  it('rejects malformed JSON with the standard error format', async () => {
    const t = await createTenant();
    const res = await server.inject({
      method: 'POST',
      url: '/v1/usage-events',
      headers: { ...bearer(t.key), 'content-type': 'application/json' },
      payload: '{"eventType": ',
    });
    expect(res.statusCode).toBe(400);
    expectErrorShape(res.json(), 'bad_request');
  });
});

describe('GET /v1/usage', () => {
  it('happy path: filters by date range and event type, newest first', async () => {
    const t = await createTenant();
    for (const [day, type] of [
      ['01', 'a'],
      ['05', 'b'],
      ['10', 'a'],
      ['20', 'a'],
    ] as const) {
      await ingest(t, {
        eventType: type,
        quantity: Number(day),
        occurredAt: `2026-04-${day}T00:00:00Z`,
      });
    }
    const all = await server.inject({ method: 'GET', url: '/v1/usage', headers: bearer(t.key) });
    expect(all.statusCode).toBe(200);
    expect(all.json().items.map((i: { quantity: number }) => i.quantity)).toEqual([20, 10, 5, 1]);
    expect(all.json().nextCursor).toBeNull();

    const ranged = await server.inject({
      method: 'GET',
      url: '/v1/usage?from=2026-04-05T00:00:00Z&to=2026-04-20T00:00:00Z',
      headers: bearer(t.key),
    });
    expect(ranged.json().items.map((i: { quantity: number }) => i.quantity)).toEqual([10, 5]);

    const typed = await server.inject({
      method: 'GET',
      url: '/v1/usage?eventType=a',
      headers: bearer(t.key),
    });
    expect(typed.json().items).toHaveLength(3);
  });

  it('paginates with a cursor without gaps or duplicates (including identical timestamps)', async () => {
    const t = await createTenant();
    const sameTime = '2026-05-01T00:00:00Z';
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await ingest(t, {
        eventType: 'p',
        quantity: i,
        occurredAt: i < 4 ? sameTime : `2026-05-0${i}T00:00:00Z`,
      });
      ids.push(res.json().id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/usage?limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await server.inject({ method: 'GET', url, headers: bearer(t.key) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBeLessThanOrEqual(3);
      seen.push(...body.items.map((i: { id: string }) => i.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('validates query parameters', async () => {
    const t = await createTenant();
    for (const [qs, code] of [
      ['limit=0', 'validation_error'],
      ['limit=201', 'validation_error'],
      ['from=yesterday', 'validation_error'],
      ['unknown=1', 'validation_error'],
      ['cursor=garbage', 'invalid_cursor'],
      ['from=2026-05-02T00:00:00Z&to=2026-05-01T00:00:00Z', 'invalid_range'],
    ] as const) {
      const res = await server.inject({
        method: 'GET',
        url: `/v1/usage?${qs}`,
        headers: bearer(t.key),
      });
      expect(res.statusCode, qs).toBe(400);
      expectErrorShape(res.json(), code);
    }
  });

  it("tenant A's key can never read tenant B's usage", async () => {
    const a = await createTenant('iso-a');
    const b = await createTenant('iso-b');
    const bEvent = (
      await ingest(b, { eventType: 'secret', quantity: 999, occurredAt: '2026-06-01T00:00:00Z' })
    ).json();
    await ingest(a, { eventType: 'mine', quantity: 1, occurredAt: '2026-06-01T00:00:00Z' });

    const readA = await server.inject({ method: 'GET', url: '/v1/usage', headers: bearer(a.key) });
    const itemsA = readA.json().items as { id: string; eventType: string }[];
    expect(itemsA.map((i) => i.eventType)).toEqual(['mine']);
    expect(itemsA.some((i) => i.id === bEvent.id)).toBe(false);
    expect(readA.body).not.toContain('secret');

    // Even filtering exactly on B's data, and with a cursor pointing at B's event, yields nothing of B's.
    const filtered = await server.inject({
      method: 'GET',
      url: '/v1/usage?eventType=secret',
      headers: bearer(a.key),
    });
    expect(filtered.json().items).toEqual([]);
    const cursor = Buffer.from(
      JSON.stringify({ t: '2026-06-02T00:00:00.000000Z', i: bEvent.id }),
    ).toString('base64url');
    const withCursor = await server.inject({
      method: 'GET',
      url: `/v1/usage?cursor=${cursor}`,
      headers: bearer(a.key),
    });
    expect(withCursor.json().items.every((i: { id: string }) => i.id !== bEvent.id)).toBe(true);

    // And the reverse direction.
    const readB = await server.inject({ method: 'GET', url: '/v1/usage', headers: bearer(b.key) });
    expect(readB.json().items.map((i: { eventType: string }) => i.eventType)).toEqual(['secret']);
  });
});

describe('GET /v1/credits/balance', () => {
  it('happy path: zero for a new tenant, then reflects granted credits, per tenant', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const zero = await server.inject({
      method: 'GET',
      url: '/v1/credits/balance',
      headers: bearer(a.key),
    });
    expect(zero.statusCode).toBe(200);
    expect(zero.json()).toMatchObject({ balance: 0 });

    await admin.query(
      `INSERT INTO credit_ledger (tenant_id, amount, kind) VALUES ($1, 150, 'grant')`,
      [a.id],
    );
    await admin.query('UPDATE credit_balances SET balance = 150 WHERE tenant_id = $1', [a.id]);
    const after = await server.inject({
      method: 'GET',
      url: '/v1/credits/balance',
      headers: bearer(a.key),
    });
    expect(after.json().balance).toBe(150);
    const other = await server.inject({
      method: 'GET',
      url: '/v1/credits/balance',
      headers: bearer(b.key),
    });
    expect(other.json().balance).toBe(0);
  });
});

describe('error format and logging', () => {
  it('returns the standard error body with a request id for unknown routes', async () => {
    const res = await server.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expectErrorShape(res.json(), 'not_found');
    expect(res.headers['x-request-id']).toBe(res.json().error.requestId);
  });

  it('hides internal errors: generic 500, no stack, no internal message', async () => {
    const t = await createTenant();
    const failing = buildApp({
      db: {
        query: (sql: string) =>
          String(sql).includes('authenticate_api_key')
            ? app.query(sql, [hashApiKey(t.key)])
            : Promise.reject(new Error('secret internal detail')),
        connect: () => Promise.reject(new Error('secret internal detail: db at 10.0.0.5')),
      } as never,
    });
    const res = await failing.inject({
      method: 'GET',
      url: '/v1/credits/balance',
      headers: bearer(t.key),
    });
    expect(res.statusCode).toBe(500);
    expectErrorShape(res.json(), 'internal_error');
    expect(res.body).not.toContain('secret');
    expect(res.body).not.toContain('10.0.0.5');
    await failing.close();
  });

  it('puts the request id in every log line for a request', async () => {
    logLines.length = 0;
    const res = await server.inject({ method: 'GET', url: '/health' });
    const id = res.headers['x-request-id'] as string;
    const mine = logLines.filter((l) => l.includes(id));
    expect(mine.length).toBeGreaterThanOrEqual(1);
    for (const line of mine) expect(JSON.parse(line).requestId).toBe(id);
  });

  it('never logs API keys or Authorization headers, on success or failure', async () => {
    logLines.length = 0;
    const t = await createTenant();
    const bad = `lk_${'1'.repeat(8)}_${'B'.repeat(43)}`;
    await server.inject({ method: 'GET', url: '/v1/usage', headers: bearer(t.key) });
    await server.inject({ method: 'GET', url: '/v1/usage', headers: bearer(bad) });
    await server.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { authorization: 'Bearer garbage-token-value' },
    });
    await ingest(t, { eventType: 'x', quantity: -5 });
    const all = logLines.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [t.key, bad, 'garbage-token-value', ADMIN_TOKEN]) {
      expect(all).not.toContain(secret);
    }
    expect(all.toLowerCase()).not.toContain('authorization');
    expect(all.toLowerCase()).not.toContain('bearer');
    expect(all).not.toContain(hashApiKey(t.key));
  });
});
