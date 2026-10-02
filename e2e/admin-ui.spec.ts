import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const API = 'http://localhost:3000';
const keysFile = path.resolve(process.env.E2E_KEYS_FILE ?? '.seed/keys.json');
const tenants = (
  JSON.parse(readFileSync(keysFile, 'utf8')) as { tenants: { size: string; apiKey: string }[] }
).tenants;
const keyOf = (size: string): string => {
  const t = tenants.find((x) => x.size === size);
  if (!t) throw new Error(`no "${size}" tenant in ${keysFile}`);
  return t.apiKey;
};
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

async function signIn(page: Page, key: string): Promise<{ usageUrl: string }> {
  await page.goto('/');
  const usage = page.waitForResponse((r) => r.url().includes('/api/v1/usage/summary'));
  await page.getByLabel('Tenant API key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const url = (await usage).url();
  for (const id of ['usage', 'balance', 'queue']) {
    await expect(page.getByTestId(id)).not.toHaveAttribute('data-state', 'loading', {
      timeout: 30_000,
    });
  }
  return { usageUrl: url };
}

async function direct<T>(request: APIRequestContext, urlPath: string, key: string): Promise<T> {
  const res = await request.get(`${API}${urlPath}`, { headers: auth(key) });
  expect(res.status(), urlPath).toBe(200);
  return (await res.json()) as T;
}

const num = async (page: Page, testId: string): Promise<number> =>
  Number(await page.getByTestId(testId).getAttribute('data-value'));

for (const size of ['huge', 'small']) {
  test(`the panels show real numbers for the ${size} tenant that match a direct API call`, async ({
    page,
    request,
  }) => {
    const key = keyOf(size);
    const { usageUrl } = await signIn(page, key);

    // Balance and ledger
    const balance = await direct<{ balance: number }>(request, '/v1/credits/balance', key);
    expect(await num(page, 'balance-value')).toBe(balance.balance);
    const ledger = await direct<{ items: { id: number }[] }>(
      request,
      '/v1/credits/ledger?limit=10',
      key,
    );
    const shown = await page
      .getByTestId('ledger-row')
      .evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-id'))));
    expect(shown).toEqual(ledger.items.map((i) => i.id));

    // Usage over time: the same window the UI asked for, summed
    const usage = await direct<{ days: { events: number; quantity: number }[] }>(
      request,
      usageUrl.replace(/^.*\/api/, ''),
      key,
    );
    expect(usage.days.length).toBeGreaterThan(0);
    expect(await num(page, 'usage-total-events')).toBe(
      usage.days.reduce((s, d) => s + d.events, 0),
    );
    expect(await num(page, 'usage-total-quantity')).toBe(
      usage.days.reduce((s, d) => s + d.quantity, 0),
    );
    await expect(page.getByRole('img', { name: /Bar chart of daily usage/ })).toBeVisible();

    // Queue health
    const queue = await direct<{ counts: Record<string, number> }>(request, '/v1/queue/stats', key);
    for (const [state, n] of Object.entries(queue.counts)) {
      expect(await num(page, `queue-count-${state}`), state).toBe(n);
    }

    if (process.env.E2E_SCREENSHOTS) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: path.resolve(`docs/img/admin-ui-${size}.png`),
        fullPage: true,
      });
    }
  });
}

test('a tenant key never shows another tenant data in the UI (small and huge, both directions)', async ({
  page,
  request,
}) => {
  const ids = async (key: string): Promise<number[]> =>
    (
      await direct<{ items: { id: number }[] }>(request, '/v1/credits/ledger?limit=100', key)
    ).items.map((i) => i.id);
  const idsSmall = await ids(keyOf('small'));
  const idsHuge = await ids(keyOf('huge'));
  expect(idsSmall.length).toBeGreaterThan(0);
  expect(idsHuge.length).toBeGreaterThan(0);
  expect(idsSmall.filter((i) => idsHuge.includes(i))).toEqual([]);

  for (const [mine, theirs] of [
    ['small', idsHuge],
    ['huge', idsSmall],
  ] as const) {
    await signIn(page, keyOf(mine));
    const shown = await page
      .getByTestId('ledger-row')
      .evaluateAll((rows) => rows.map((r) => Number(r.getAttribute('data-id'))));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.filter((i) => theirs.includes(i))).toEqual([]);
    const html = await page.content();
    expect(html).not.toContain(keyOf(mine)); // the key is never rendered
    await page.getByRole('button', { name: 'Sign out' }).click();
  }
});

test('a wrong key shows the unauthorized state in every panel, and the key is not kept anywhere', async ({
  page,
}) => {
  const key = 'lk_00000000_' + 'A'.repeat(43);
  await page.goto('/');
  await page.getByLabel('Tenant API key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Sign in' }).click();
  for (const id of ['usage', 'balance', 'queue']) {
    await expect(page.getByTestId(id)).toHaveAttribute('data-state', 'unauthorized');
  }
  await expect(page.getByText(/key was not accepted/).first()).toBeVisible();
  const stored = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
    cookie: document.cookie,
    url: location.href,
  }));
  for (const v of Object.values(stored)) expect(v).not.toContain(key);
  // reload signs out: the key was only in memory
  await page.reload();
  await expect(page.getByLabel('Tenant API key', { exact: true })).toHaveValue('');
});
