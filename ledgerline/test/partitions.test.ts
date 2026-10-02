/**
 * Automatic partition creation (migration 0008). Runs in its own scratch database so the shared
 * test database (and its 48-partition assertions) is untouched. The scratch database starts with
 * the partitions of 0001 minus everything after 2026-10, so the "next month does not exist yet"
 * situation is real, not simulated.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { appUrlFrom } from '../src/db/config.js';
import { migrate } from '../src/db/migrate.js';
import { ensurePartitions } from '../src/partitions.js';
import { serverAdminUrl } from './helpers.js';

const DB = 'ledgerline_partitions_test';
const ADMIN_TOKEN = 'partitions-test-token';
const LAST_KEPT = '2026_10';

function withDb(url: string): string {
  const u = new URL(url);
  u.pathname = `/${DB}`;
  return u.toString();
}

let admin: pg.Pool;
let app: pg.Pool;
let api: ReturnType<typeof buildApp>;

async function partitionNames(): Promise<string[]> {
  const r = await admin.query<{ name: string }>(
    `SELECT inhrelid::regclass::text AS name FROM pg_inherits
     WHERE inhparent = 'usage_events'::regclass ORDER BY 1`,
  );
  return r.rows.map((x) => x.name);
}

/** Back to "partitions exist up to 2026-10 only". */
async function dropFuturePartitions(): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query('SET ROLE ledgerline_owner');
    for (const name of await partitionNames()) {
      if (name > `usage_events_${LAST_KEPT}`) await c.query(`DROP TABLE ${name}`);
    }
  } finally {
    await c.query('RESET ROLE');
    c.release();
  }
}

async function ensureAt(now: string, months: number, pool: pg.Pool = admin) {
  const r = await pool.query<{ partition_name: string; created: boolean }>(
    `SELECT * FROM ledgerline_fn.ensure_usage_events_partitions_at($1::timestamptz, $2)`,
    [now, months],
  );
  return r.rows;
}

async function newTenant(): Promise<{ id: string; key: string }> {
  const res = await api.inject({
    method: 'POST',
    url: '/v1/tenants',
    headers: { 'x-admin-token': ADMIN_TOKEN },
    payload: { name: 'part', ownerEmail: `${Math.random().toString(36).slice(2)}@part.test` },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().tenant.id, key: res.json().apiKey.key };
}

function ingest(key: string, occurredAt: string) {
  return api.inject({
    method: 'POST',
    url: '/v1/usage-events',
    headers: { authorization: `Bearer ${key}` },
    payload: { eventType: 'boundary', quantity: 1, occurredAt },
  });
}

beforeAll(async () => {
  const server = new pg.Client({ connectionString: serverAdminUrl() });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${DB}`);
  await server.end();
  await migrate(withDb(serverAdminUrl()));
  admin = new pg.Pool({ connectionString: withDb(serverAdminUrl()), max: 30 });
  app = new pg.Pool({ connectionString: appUrlFrom(withDb(serverAdminUrl())), max: 30 });
  api = buildApp({ db: app, tenantCreationToken: ADMIN_TOKEN });
  await api.ready();
  await dropFuturePartitions();
});

afterAll(async () => {
  await api.close();
  await admin.end();
  await app.end();
  const server = new pg.Client({ connectionString: serverAdminUrl() });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await server.end();
});

describe('partitions: the problem and the creation function', () => {
  it('without the next partition an event is rejected (the failure the automation prevents)', async () => {
    const t = await newTenant();
    const res = await ingest(t.key, '2026-11-01T00:00:00Z');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('occurred_at_out_of_range');
    expect((await ingest(t.key, '2026-10-31T23:59:59Z')).statusCode).toBe(201);
  });

  it('creates exactly the missing months with exact UTC bounds, and a second call creates nothing', async () => {
    const first = await ensureAt('2026-10-15T12:00:00Z', 3);
    expect(first).toEqual([
      { partition_name: 'usage_events_2026_10', created: false },
      { partition_name: 'usage_events_2026_11', created: true },
      { partition_name: 'usage_events_2026_12', created: true },
      { partition_name: 'usage_events_2027_01', created: true },
    ]);
    const bounds = await admin.query(
      `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS b FROM pg_class c
       WHERE c.relname IN ('usage_events_2026_11', 'usage_events_2027_01') ORDER BY 1`,
    );
    expect(bounds.rows).toEqual([
      {
        relname: 'usage_events_2026_11',
        b: "FOR VALUES FROM ('2026-11-01 00:00:00+00') TO ('2026-12-01 00:00:00+00')",
      },
      {
        relname: 'usage_events_2027_01',
        b: "FOR VALUES FROM ('2027-01-01 00:00:00+00') TO ('2027-02-01 00:00:00+00')",
      },
    ]);
    expect((await partitionNames()).at(-1)).toBe('usage_events_2027_01');
    const second = await ensureAt('2026-10-15T12:00:00Z', 3);
    expect(second.every((r) => !r.created)).toBe(true);
    expect(second).toHaveLength(4);
  });

  it('uses UTC, whatever the session time zone is', async () => {
    const c = await admin.connect();
    try {
      await c.query(`SET TIME ZONE 'Pacific/Auckland'`); // UTC+13 in summer
      // 2027-01-31T23:30Z is already 2027-02-01 locally; the month must still be January (UTC).
      const r = await c.query(
        `SELECT * FROM ledgerline_fn.ensure_usage_events_partitions_at('2027-01-31T23:30:00Z', 1)`,
      );
      expect(r.rows.map((x) => x.partition_name)).toEqual([
        'usage_events_2027_01',
        'usage_events_2027_02',
      ]);
      await c.query('RESET TIME ZONE'); // bounds are displayed in the reading session's zone
      const b = await c.query(
        `SELECT pg_get_expr(relpartbound, oid) AS b FROM pg_class WHERE relname = 'usage_events_2027_02'`,
      );
      expect(b.rows[0].b).toBe(
        "FOR VALUES FROM ('2027-02-01 00:00:00+00') TO ('2027-03-01 00:00:00+00')",
      );
    } finally {
      c.release();
    }
    await dropFuturePartitions();
    await ensureAt('2026-10-15T12:00:00Z', 3);
  });

  it('new partitions match the old ones: indexes attached to the parent, constraints, owner, no app privileges', async () => {
    const shape = async (name: string) => {
      const idx = await admin.query(
        `SELECT regexp_replace(i.indexrelid::regclass::text, '^usage_events_[0-9_]+?_(pkey|tenant_id_occurred_at_idx)$', '\\1') AS idx,
                pg_get_indexdef(i.indexrelid) ~ 'btree' AS btree,
                EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = i.indexrelid) AS attached
         FROM pg_index i WHERE i.indrelid = $1::regclass ORDER BY 1`,
        [name],
      );
      const con = await admin.query(
        `SELECT contype, conname FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY 2`,
        [name],
      );
      const meta = await admin.query(
        `SELECT pg_get_userbyid(relowner) AS owner,
                has_table_privilege('ledgerline_app', oid, 'SELECT') AS app_select,
                has_table_privilege('ledgerline_app', oid, 'INSERT') AS app_insert
         FROM pg_class WHERE oid = $1::regclass`,
        [name],
      );
      return {
        idx: idx.rows,
        con: con.rows.map((r) => r.contype).sort(),
        meta: meta.rows[0],
      };
    };
    const old = await shape('usage_events_2026_10');
    const created = await shape('usage_events_2026_12');
    expect(created).toEqual(old);
    expect(created.idx).toEqual([
      { idx: 'pkey', btree: true, attached: true },
      { idx: 'tenant_id_occurred_at_idx', btree: true, attached: true },
    ]);
    expect(created.meta).toEqual({
      owner: 'ledgerline_owner',
      app_select: false,
      app_insert: false,
    });
  });

  it('rows in a new partition are protected by the same RLS, and the partition is not reachable directly', async () => {
    const a = await newTenant();
    const b = await newTenant();
    expect((await ingest(a.key, '2026-12-05T10:00:00Z')).statusCode).toBe(201);
    const read = (key: string) =>
      api.inject({
        method: 'GET',
        url: '/v1/usage?from=2026-12-01T00:00:00Z&to=2027-01-01T00:00:00Z',
        headers: { authorization: `Bearer ${key}` },
      });
    expect((await read(a.key)).json().items).toHaveLength(1);
    expect((await read(b.key)).json().items).toHaveLength(0);
    await expect(app.query('SELECT 1 FROM usage_events_2026_12')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('rejects out-of-range arguments and the app role cannot name its own clock', async () => {
    for (const months of [-1, 25]) {
      await expect(ensureAt('2026-10-15T00:00:00Z', months)).rejects.toMatchObject({
        code: '22023',
      });
    }
    await expect(
      app.query(`SELECT * FROM ledgerline_fn.ensure_usage_events_partitions_at(now(), 1)`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(ensurePartitions(app, 99)).rejects.toMatchObject({ code: '22023' });
    // The app role cannot create tables itself.
    await expect(app.query('CREATE TABLE usage_events_2099_01 (id int)')).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('partitions: UTC bounds whatever the session time zone is (0009)', () => {
  const ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles'];

  async function bounds(name: string): Promise<string> {
    const c = await admin.connect();
    try {
      await c.query(`SET TIME ZONE 'UTC'`); // bounds are displayed in the reading session's zone
      const r = await c.query(
        `SELECT pg_get_expr(relpartbound, oid) AS b FROM pg_class WHERE relname = $1`,
        [name],
      );
      return r.rows[0].b as string;
    } finally {
      c.release();
    }
  }

  it('every partition from 0001 has exactly the UTC month boundaries', async () => {
    const r = await admin.query(
      `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS b FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid WHERE i.inhparent = 'usage_events'::regclass`,
    );
    expect(r.rowCount).toBeGreaterThanOrEqual(34);
    for (const row of r.rows) {
      const [, y, m] = /usage_events_(\d{4})_(\d\d)/.exec(row.relname)!;
      const next =
        m === '12' ? `${Number(y) + 1}-01` : `${y}-${String(Number(m) + 1).padStart(2, '0')}`;
      expect(row.b, row.relname).toBe(
        `FOR VALUES FROM ('${y}-${m}-01 00:00:00+00') TO ('${next}-01 00:00:00+00')`,
      );
    }
  });

  it('create_usage_events_partition and ensure_usage_events_partitions_at give identical bounds under UTC, Asia/Kolkata and America/Los_Angeles', async () => {
    const months = ['2030-03', '2030-04', '2030-05'];
    const viaCreate: string[] = [];
    for (const [i, zone] of ZONES.entries()) {
      const c = await admin.connect();
      try {
        await c.query('SET ROLE ledgerline_owner');
        await c.query(`SET TIME ZONE '${zone}'`);
        const r = await c.query(`SELECT create_usage_events_partition($1::date) AS n`, [
          `${months[i]}-15`,
        ]);
        expect(r.rows[0].n).toBe(`usage_events_${months[i]!.replace('-', '_')}`);
      } finally {
        await c.query('RESET ROLE');
        await c.query('RESET TIME ZONE');
        c.release();
      }
      viaCreate.push(await bounds(`usage_events_${months[i]!.replace('-', '_')}`));
    }
    expect(viaCreate).toEqual([
      "FOR VALUES FROM ('2030-03-01 00:00:00+00') TO ('2030-04-01 00:00:00+00')",
      "FOR VALUES FROM ('2030-04-01 00:00:00+00') TO ('2030-05-01 00:00:00+00')",
      "FOR VALUES FROM ('2030-05-01 00:00:00+00') TO ('2030-06-01 00:00:00+00')",
    ]);
    // The same months made by the other function under the other zones (fresh month names).
    const viaEnsure: string[] = [];
    for (const [i, zone] of ZONES.entries()) {
      const c = await admin.connect();
      try {
        await c.query(`SET TIME ZONE '${zone}'`);
        await c.query(
          `SELECT * FROM ledgerline_fn.ensure_usage_events_partitions_at($1::timestamptz, 0)`,
          [`2031-0${i + 3}-15T12:00:00Z`],
        );
      } finally {
        await c.query('RESET TIME ZONE');
        c.release();
      }
      viaEnsure.push(await bounds(`usage_events_2031_0${i + 3}`));
    }
    expect(viaEnsure.map((b) => b.replaceAll('2031', 'Y'))).toEqual(
      viaCreate.map((b) => b.replaceAll('2030', 'Y')),
    );
  });

  it('events at 23:59:59 and 00:00:00 UTC on a month change land in the right partitions under non-UTC session zones', async () => {
    // 2030-03 / 2030-04 / 2030-05 exist from the previous test.
    const t = await newTenant();
    for (const zone of ['Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland']) {
      const c = await app.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SET LOCAL TIME ZONE '${zone}'`);
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [t.id]);
        await c.query(
          `INSERT INTO usage_events (tenant_id, occurred_at, event_type, quantity) VALUES
             ($1, '2030-03-31T23:59:59Z', $2, 1), ($1, '2030-04-01T00:00:00Z', $2, 1)`,
          [t.id, `boundary-${zone}`],
        );
        await c.query('COMMIT');
      } finally {
        c.release();
      }
    }
    const r = await admin.query(
      `SELECT event_type, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS t,
              tableoid::regclass::text AS part
       FROM usage_events WHERE tenant_id = $1 AND event_type LIKE 'boundary-%' ORDER BY 1, 2`,
      [t.id],
    );
    expect(r.rowCount).toBe(6);
    for (const row of r.rows) {
      expect(row.part, `${row.event_type} ${row.t}`).toBe(
        row.t === '2030-03-31T23:59:59' ? 'usage_events_2030_03' : 'usage_events_2030_04',
      );
    }
  });
});

describe('partitions: concurrency', () => {
  it('30 simultaneous callers: each missing partition is created exactly once, nobody errors', async () => {
    await dropFuturePartitions();
    const callers = Array.from({ length: 30 }, () =>
      ensureAt('2026-10-15T12:00:00Z', 6, admin).then((rows) => rows.filter((r) => r.created)),
    );
    const results = await Promise.all(callers);
    const createdNames = results
      .flat()
      .map((r) => r.partition_name)
      .sort();
    expect(createdNames).toEqual([
      'usage_events_2026_11',
      'usage_events_2026_12',
      'usage_events_2027_01',
      'usage_events_2027_02',
      'usage_events_2027_03',
      'usage_events_2027_04',
    ]);
    expect(await partitionNames()).toHaveLength(34 + 6); // 2024-01 .. 2026-10 plus six months
  });

  it('through the app role pool (what the API does) is the same', async () => {
    await dropFuturePartitions();
    const now = new Date();
    const expected = [0, 1, 2]
      .map((i) => {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
        return `usage_events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      })
      .filter((n) => n > `usage_events_${LAST_KEPT}`); // the others still exist
    const all = await Promise.all(Array.from({ length: 20 }, () => ensurePartitions(app, 2)));
    expect(
      all
        .flat()
        .filter((r) => r.created)
        .map((r) => r.name)
        .sort(),
    ).toEqual(expected);
  });
});

describe('partitions: ingest never fails at a month boundary', () => {
  it('events straddling 2026-10-31 -> 2026-11-01 are all accepted while the job keeps creating partitions', async () => {
    await dropFuturePartitions();
    expect(await partitionNames()).toHaveLength(34); // nothing after 2026-10
    const t = await newTenant();
    const WORKERS = 30;
    const PER_WORKER = 30;
    const base = Date.parse('2026-10-31T23:59:00Z');
    const failures: string[] = [];
    let accepted = 0;
    let ingestDone = false;

    // The maintenance job ticks every few milliseconds with a clock that crosses the boundary:
    // one minute before midnight, then after it. It always keeps 2 months ahead.
    const job = (async () => {
      let tick = 0;
      while (!ingestDone) {
        const now = new Date(base + (tick % 4) * 30_000).toISOString(); // 23:59:00 .. 00:00:30
        await ensureAt(now, 2, admin);
        tick++;
      }
    })();

    await ensureAt('2026-10-31T23:59:00Z', 1, admin); // the state just before the boundary
    const workers = Array.from({ length: WORKERS }, async (_, w) => {
      for (let i = 0; i < PER_WORKER; i++) {
        // spread over 23:59:30 .. 00:00:30 so about half the events are on each side
        const ms = base + 30_000 + ((w * PER_WORKER + i) % 60) * 1000 + (i % 7);
        const res = await ingest(t.key, new Date(ms).toISOString());
        if (res.statusCode === 201) accepted++;
        else failures.push(`${res.statusCode} ${res.body}`);
      }
    });
    await Promise.all(workers);
    ingestDone = true;
    await job;

    expect(failures).toEqual([]);
    expect(accepted).toBe(WORKERS * PER_WORKER);
    const where = await admin.query(
      `SELECT tableoid::regclass::text AS part, count(*)::int AS n,
              bool_and(to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY_MM') = substr(tableoid::regclass::text, 14)) AS right_partition
       FROM usage_events WHERE tenant_id = $1 GROUP BY 1 ORDER BY 1`,
      [t.id],
    );
    expect(where.rows.map((r) => r.part)).toEqual(['usage_events_2026_10', 'usage_events_2026_11']);
    expect(where.rows.every((r) => r.right_partition)).toBe(true);
    expect(where.rows.reduce((s, r) => s + r.n, 0)).toBe(WORKERS * PER_WORKER);
    expect(where.rows.every((r) => r.n > 100)).toBe(true); // events really landed on both sides
    console.log(
      `PARTITION BOUNDARY TEST: ${WORKERS * PER_WORKER} events by ${WORKERS} workers across the ` +
        `2026-10/2026-11 boundary while the maintenance job ran concurrently: ` +
        `${accepted} accepted, ${failures.length} failed (` +
        `${where.rows.map((r) => `${r.part}: ${r.n}`).join(', ')})`,
    );
  });
});
