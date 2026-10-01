import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { debitCredits, debitIn, refundCredits } from '../src/credits.js';
import { withTenant } from '../src/db/tenant.js';
import { adminPool, testAppUrl } from './helpers.js';

const WORKERS = 50;
let admin: pg.Pool;
let app: pg.Pool; // 50 real connections: every worker below gets its own session

beforeAll(() => {
  admin = adminPool();
  app = new pg.Pool({ connectionString: testAppUrl(), max: WORKERS });
});
afterAll(async () => {
  await admin.end();
  await app.end();
});

/** A tenant with a balance row and an initial grant so that ledger sum equals balance. */
async function makeTenant(balance: number): Promise<string> {
  const t = await admin.query<{ id: string }>(
    `INSERT INTO tenants (name) VALUES ('credits-test') RETURNING id`,
  );
  const id = t.rows[0]!.id;
  await admin.query(`INSERT INTO credit_balances (tenant_id, balance) VALUES ($1, $2)`, [
    id,
    balance,
  ]);
  if (balance > 0) {
    await admin.query(
      `INSERT INTO credit_ledger (tenant_id, amount, kind, balance_after) VALUES ($1, $2, 'grant', $2)`,
      [id, balance],
    );
  }
  return id;
}

async function balanceOf(tenant: string): Promise<number> {
  const r = await admin.query(
    `SELECT balance::int AS b FROM credit_balances WHERE tenant_id = $1`,
    [tenant],
  );
  return r.rows[0].b;
}

async function ledgerRows(tenant: string, key?: string) {
  const r = await admin.query(
    `SELECT id::int, amount::int, kind, idempotency_key, refund_of::int, balance_after::int
     FROM credit_ledger WHERE tenant_id = $1 ${key ? 'AND idempotency_key = $2' : ''} ORDER BY id`,
    key ? [tenant, key] : [tenant],
  );
  return r.rows;
}

/** The invariant: for every tenant, ledger sum equals balance, and no balance is negative. */
async function expectInvariant(): Promise<void> {
  const mismatches = await admin.query(
    `SELECT b.tenant_id, b.balance, coalesce(l.s, 0) AS ledger_sum
     FROM credit_balances b
     LEFT JOIN (SELECT tenant_id, sum(amount) AS s FROM credit_ledger GROUP BY tenant_id) l
       USING (tenant_id)
     WHERE b.balance <> coalesce(l.s, 0) OR b.balance < 0`,
  );
  expect(mismatches.rows, 'tenants whose ledger sum differs from balance').toEqual([]);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('debit: 50 parallel workers, 10,000 debits, some must be rejected', () => {
  it('never overdrafts, never double-spends, and the ledger always equals the balance', async () => {
    const TENANTS = 5;
    const DEBITS = 10_000;
    const INITIAL = 5_000;
    const tenants = await Promise.all(Array.from({ length: TENANTS }, () => makeTenant(INITIAL)));

    const rand = mulberry32(20251001);
    const ops = Array.from({ length: DEBITS }, (_, i) => ({
      tenant: tenants[Math.floor(rand() * TENANTS)]!,
      amount: 1 + Math.floor(rand() * 10),
      key: `bulk-${i}`,
    }));
    const demand = ops.reduce((a, o) => a + o.amount, 0);
    expect(demand, 'demand must exceed supply so rejections are required').toBeGreaterThan(
      TENANTS * INITIAL,
    );

    const results: Awaited<ReturnType<typeof debitCredits>>[] = new Array(DEBITS);
    let next = 0;
    const started = Date.now();
    await Promise.all(
      Array.from({ length: WORKERS }, async () => {
        for (;;) {
          const i = next++;
          if (i >= DEBITS) return;
          const op = ops[i]!;
          results[i] = await debitCredits(app, op.tenant, op.amount, op.key);
        }
      }),
    );
    const seconds = (Date.now() - started) / 1000;

    const accepted = results.filter((r) => r.outcome === 'debited');
    const rejected = results.filter((r) => r.outcome === 'insufficient_credits');
    console.log(
      `DEBIT TEST: ${DEBITS} debits by ${WORKERS} workers in ${seconds.toFixed(1)}s: ` +
        `${accepted.length} accepted, ${rejected.length} rejected (insufficient credits)`,
    );
    expect(accepted.length + rejected.length).toBe(DEBITS);
    expect(rejected.length).toBeGreaterThan(0);
    expect(accepted.length).toBeGreaterThan(0);
    expect(results.every((r) => !r.replayed)).toBe(true);

    for (const tenant of tenants) {
      const mine = ops.map((o, i) => ({ o, r: results[i]! })).filter((x) => x.o.tenant === tenant);
      const acceptedHere = mine.filter((x) => x.r.outcome === 'debited');
      const spent = acceptedHere.reduce((a, x) => a + x.o.amount, 0);

      // No overdraft; balance is exactly initial minus what was accepted (no double-spend).
      const balance = await balanceOf(tenant);
      expect(balance).toBeGreaterThanOrEqual(0);
      expect(balance).toBe(INITIAL - spent);

      // Exactly one ledger row per accepted debit, none for rejected ones.
      const rows = await ledgerRows(tenant);
      const debits = rows.filter((r) => r.kind === 'debit');
      expect(debits.length).toBe(acceptedHere.length);
      expect(new Set(debits.map((r) => r.idempotency_key)).size).toBe(debits.length);
      expect(rows.reduce((a, r) => a + r.amount, 0)).toBe(balance);

      // Serial equivalence: replaying the ledger in id order reproduces every balance seen.
      let running = INITIAL;
      for (const row of debits) {
        running += row.amount;
        expect(row.balance_after).toBe(running);
        expect(running).toBeGreaterThanOrEqual(0);
      }
      expect(running).toBe(balance);

      // Every rejection was justified: the balance the function saw was too small.
      for (const x of mine.filter((m) => m.r.outcome === 'insufficient_credits')) {
        expect(x.r.balance).toBeLessThan(x.o.amount);
      }
    }
    await expectInvariant();
  }, 120_000);
});

describe('debit: idempotency', () => {
  it('the same key sent by 50 workers at once writes exactly one ledger row', async () => {
    const tenant = await makeTenant(1_000);
    for (let round = 0; round < 5; round++) {
      const key = `same-key-${round}`;
      const results = await Promise.all(
        Array.from({ length: WORKERS }, () => debitCredits(app, tenant, 7, key)),
      );
      expect(results.every((r) => r.outcome === 'debited')).toBe(true);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.ledgerId)).size).toBe(1);
      expect(new Set(results.map((r) => r.balance)).size).toBe(1); // the original result
      expect(await ledgerRows(tenant, key)).toHaveLength(1);
    }
    expect(await balanceOf(tenant)).toBe(1_000 - 5 * 7);
    await expectInvariant();
  });

  it('the same key with a different amount is rejected, sequentially and concurrently', async () => {
    const tenant = await makeTenant(1_000);
    const first = await debitCredits(app, tenant, 10, 'k1');
    expect(first.outcome).toBe('debited');

    const conflict = await debitCredits(app, tenant, 11, 'k1');
    expect(conflict.outcome).toBe('idempotency_conflict');
    expect(conflict.ledgerId).toBe(first.ledgerId); // points at the row that owns the key
    expect(await ledgerRows(tenant, 'k1')).toHaveLength(1);
    expect(await balanceOf(tenant)).toBe(990);

    // Concurrent: 25 workers send amount 3 and 25 send amount 4 under one new key. Exactly one
    // amount wins; everyone with the other amount is rejected; one ledger row.
    const results = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        debitCredits(app, tenant, i % 2 === 0 ? 3 : 4, 'k2'),
      ),
    );
    const rows = await ledgerRows(tenant, 'k2');
    expect(rows).toHaveLength(1);
    const winner = -rows[0]!.amount;
    for (const [i, r] of results.entries()) {
      const amount = i % 2 === 0 ? 3 : 4;
      expect(r.outcome).toBe(amount === winner ? 'debited' : 'idempotency_conflict');
    }
    expect(await balanceOf(tenant)).toBe(990 - winner);
    await expectInvariant();
  });

  it('a key used by a refund cannot be reused for a debit', async () => {
    const tenant = await makeTenant(100);
    const d = await debitCredits(app, tenant, 10, 'debit-1');
    const r = await refundCredits(app, tenant, d.ledgerId!, 10, 'refund-key');
    expect(r.outcome).toBe('refunded');
    const clash = await debitCredits(app, tenant, 10, 'refund-key');
    expect(clash.outcome).toBe('idempotency_conflict');
    await expectInvariant();
  });

  it('a rejected debit writes nothing and a later retry is evaluated afresh', async () => {
    const tenant = await makeTenant(5);
    const no = await debitCredits(app, tenant, 6, 'poor');
    expect(no).toMatchObject({ outcome: 'insufficient_credits', ledgerId: null, balance: 5 });
    expect(await ledgerRows(tenant, 'poor')).toHaveLength(0);
    await admin.query(`UPDATE credit_balances SET balance = 20 WHERE tenant_id = $1`, [tenant]);
    await admin.query(
      `INSERT INTO credit_ledger (tenant_id, amount, kind) VALUES ($1, 15, 'grant')`,
      [tenant],
    );
    const yes = await debitCredits(app, tenant, 6, 'poor');
    expect(yes.outcome).toBe('debited');
    expect(yes.balance).toBe(14);
    await expectInvariant();
  });
});

describe('refund', () => {
  it('succeeds once, as a new append-only row that points at the debit', async () => {
    const tenant = await makeTenant(100);
    const d = await debitCredits(app, tenant, 30, 'd1');
    expect(d.balance).toBe(70);
    const r = await refundCredits(app, tenant, d.ledgerId!, 20, 'r1', 'partial');
    expect(r).toMatchObject({ outcome: 'refunded', balance: 90, replayed: false });

    const rows = await ledgerRows(tenant);
    const refund = rows.find((x) => x.kind === 'refund')!;
    expect(refund.refund_of).toBe(d.ledgerId);
    expect(refund.amount).toBe(20);
    const debit = rows.find((x) => x.kind === 'debit')!;
    expect(debit.amount).toBe(-30); // the original row was not modified
    expect(await balanceOf(tenant)).toBe(90);

    // Replaying the same refund returns the original result and writes nothing.
    const again = await refundCredits(app, tenant, d.ledgerId!, 20, 'r1', 'partial');
    expect(again).toMatchObject({
      outcome: 'refunded',
      replayed: true,
      ledgerId: r.ledgerId,
      balance: 90,
    });
    expect((await ledgerRows(tenant)).filter((x) => x.kind === 'refund')).toHaveLength(1);
    await expectInvariant();
  });

  it('rejects a second refund of the same debit, even a partial one with a new key', async () => {
    const tenant = await makeTenant(100);
    const d = await debitCredits(app, tenant, 30, 'd1');
    await refundCredits(app, tenant, d.ledgerId!, 10, 'r1');
    const second = await refundCredits(app, tenant, d.ledgerId!, 5, 'r2');
    expect(second.outcome).toBe('already_refunded');
    expect(await balanceOf(tenant)).toBe(80);
    await expectInvariant();
  });

  it('rejects a refund above the original debit and writes nothing', async () => {
    const tenant = await makeTenant(100);
    const d = await debitCredits(app, tenant, 30, 'd1');
    const r = await refundCredits(app, tenant, d.ledgerId!, 31, 'r1');
    expect(r.outcome).toBe('refund_exceeds_debit');
    expect(await ledgerRows(tenant, 'r1')).toHaveLength(0);
    expect(await balanceOf(tenant)).toBe(70);
    // The full original amount is still refundable afterwards.
    expect((await refundCredits(app, tenant, d.ledgerId!, 30, 'r2')).outcome).toBe('refunded');
    expect(await balanceOf(tenant)).toBe(100);
    await expectInvariant();
  });

  it('rejects unknown debits, other tenants debits, and refunds of non-debit rows', async () => {
    const a = await makeTenant(100);
    const b = await makeTenant(100);
    const da = await debitCredits(app, a, 10, 'da');
    expect((await refundCredits(app, a, 999_999_999, 5, 'x1')).outcome).toBe('debit_not_found');
    // Tenant B cannot refund tenant A's debit (RLS hides it): treated as not found.
    expect((await refundCredits(app, b, da.ledgerId!, 5, 'x2')).outcome).toBe('debit_not_found');
    expect(await balanceOf(b)).toBe(100);
    // A grant row is not a debit.
    const grant = (await ledgerRows(a)).find((r) => r.kind === 'grant')!;
    expect((await refundCredits(app, a, grant.id, 5, 'x3')).outcome).toBe('debit_not_found');
    // A refund row is not a debit either.
    const r = await refundCredits(app, a, da.ledgerId!, 5, 'x4');
    expect((await refundCredits(app, a, r.ledgerId!, 1, 'x5')).outcome).toBe('debit_not_found');
    await expectInvariant();
  });

  it('50 concurrent refunds of one debit: exactly one succeeds', async () => {
    const tenant = await makeTenant(1_000);
    const d = await debitCredits(app, tenant, 100, 'd1');
    const results = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        refundCredits(app, tenant, d.ledgerId!, 100, `r-${i}`),
      ),
    );
    expect(results.filter((r) => r.outcome === 'refunded')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_refunded')).toHaveLength(WORKERS - 1);
    expect((await ledgerRows(tenant)).filter((r) => r.kind === 'refund')).toHaveLength(1);
    expect(await balanceOf(tenant)).toBe(1_000);
    await expectInvariant();
  });

  it('concurrent debits and refunds together keep the invariant', async () => {
    const tenant = await makeTenant(500);
    const seedDebits = await Promise.all(
      Array.from({ length: 20 }, (_, i) => debitCredits(app, tenant, 10, `seed-${i}`)),
    );
    const results = await Promise.all([
      ...seedDebits.map((d, i) => refundCredits(app, tenant, d.ledgerId!, 10, `rf-${i}`)),
      ...Array.from({ length: 30 }, (_, i) => debitCredits(app, tenant, 10, `more-${i}`)),
    ]);
    expect(results.every((r) => ['refunded', 'debited'].includes(r.outcome))).toBe(true);
    await expectInvariant();
  });
});

describe('under forced RLS, as the application role', () => {
  it('only ever touches the current tenant and refuses bad input', async () => {
    const a = await makeTenant(100);
    const b = await makeTenant(100);
    await debitCredits(app, a, 40, 'a1');
    expect(await balanceOf(a)).toBe(60);
    expect(await balanceOf(b)).toBe(100); // untouched

    // No tenant set: the function refuses.
    const c = await app.connect();
    try {
      await expect(
        c.query('SELECT * FROM ledgerline_fn.debit_credits(1, $1)', ['x']),
      ).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      c.release();
    }

    // Invalid amounts and keys.
    for (const [amount, key] of [
      [0, 'k'],
      [-5, 'k'],
      [5, ''],
    ] as const) {
      await expect(debitCredits(app, a, amount, key)).rejects.toMatchObject({ code: '22023' });
    }
    // A tenant without a balance row cannot debit.
    const t = await admin.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ('nb') RETURNING id`,
    );
    await expect(debitCredits(app, t.rows[0]!.id, 1, 'k')).rejects.toMatchObject({ code: 'P0002' });
  });

  it('a failed transaction leaves neither a ledger row nor a balance change', async () => {
    const tenant = await makeTenant(100);
    await expect(
      withTenant(app, tenant, async (c) => {
        const r = await debitIn(c, 10, 'rollback-me');
        expect(r.outcome).toBe('debited');
        throw new Error('caller fails after debiting');
      }),
    ).rejects.toThrow('caller fails');
    expect(await ledgerRows(tenant, 'rollback-me')).toHaveLength(0);
    expect(await balanceOf(tenant)).toBe(100);
    // ...so the same key can be used again, and then debits normally.
    expect((await debitCredits(app, tenant, 10, 'rollback-me')).outcome).toBe('debited');
    await expectInvariant();
  });

  it('the seed-style rows and the new functions coexist (no refund_of, no balance_after)', async () => {
    const tenant = await makeTenant(0);
    await admin.query(
      `INSERT INTO credit_ledger (tenant_id, amount, kind, idempotency_key) VALUES ($1, 500, 'grant', 'seed:grant'), ($1, -120, 'debit', 'usage:2026-01'), ($1, 6, 'refund', 'seed:refund')`,
      [tenant],
    );
    await admin.query(`UPDATE credit_balances SET balance = 386 WHERE tenant_id = $1`, [tenant]);
    expect((await debitCredits(app, tenant, 86, 'new')).balance).toBe(300);
    await expectInvariant();
  });
});
