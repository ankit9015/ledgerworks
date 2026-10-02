import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { BalancePanel, QueuePanel, UsagePanel } from '../src/Panels';

type Handler = (url: string) => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const errorBody = (status: number, message: string) =>
  json({ error: { code: 'x', message, requestId: 'r' } }, status);

function stubApi(routes: Record<string, Handler>) {
  const calls: { url: string; auth: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get('authorization') });
      const key = Object.keys(routes).find((k) => url.startsWith(`/api${k}`));
      if (!key) return Promise.resolve(errorBody(404, 'no route'));
      return Promise.resolve(routes[key]!(url));
    }),
  );
  return calls;
}
const never = () => new Promise<Response>(() => {});

const USAGE = {
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-05T00:00:00.000Z',
  days: [
    { day: '2026-09-01', events: 3, quantity: 1200 },
    { day: '2026-09-03', events: 2, quantity: 800 },
  ],
};
const BALANCE = { balance: 18000, updatedAt: '2026-09-30T10:00:00.000Z' };
const LEDGER = {
  items: [
    {
      id: 12,
      kind: 'debit',
      amount: -1800,
      balanceAfter: 18000,
      reference: 'usage',
      createdAt: '2026-09-30T10:00:00.000Z',
    },
    {
      id: 11,
      kind: 'grant',
      amount: 5000,
      balanceAfter: null,
      reference: null,
      createdAt: '2026-09-29T10:00:00.000Z',
    },
  ],
  nextCursor: null,
};
const QUEUE = {
  counts: { queued: 2, running: 1, failed: 0, succeeded: 5, dead: 1 },
  oldestRunnableAgeSeconds: 42.4,
  recentDeadLetters: [
    {
      jobId: 'j1',
      type: 'doomed',
      attempts: 3,
      lastError: 'always fails',
      deadAt: '2026-09-30T09:00:00.000Z',
    },
  ],
};
const noop = () => {};

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe('every panel has loading, empty, error, unauthorized and ready states', () => {
  interface Case {
    name: string;
    Panel: typeof UsagePanel;
    ready: Record<string, Handler>;
    empty: Record<string, Handler>;
    path: string;
    emptyText: RegExp;
    readyCheck: () => void;
  }
  const cases: Case[] = [
    {
      name: 'Usage over time',
      Panel: UsagePanel,
      ready: { '/v1/usage/summary': () => json(USAGE) },
      empty: { '/v1/usage/summary': () => json({ ...USAGE, days: [] }) },
      path: '/v1/usage/summary',
      emptyText: /No usage events/,
      readyCheck: () =>
        expect(screen.getByTestId('usage-total-quantity')).toHaveTextContent('2,000'),
    },
    {
      name: 'Credit balance',
      Panel: BalancePanel,
      ready: {
        '/v1/credits/balance': () => json(BALANCE),
        '/v1/credits/ledger': () => json(LEDGER),
      },
      empty: {
        '/v1/credits/balance': () => json({ balance: 0, updatedAt: null }),
        '/v1/credits/ledger': () => json({ items: [], nextCursor: null }),
      },
      path: '/v1/credits/balance',
      emptyText: /no credits and no ledger entries/,
      readyCheck: () => {
        expect(screen.getByTestId('balance-value')).toHaveTextContent('18,000');
        expect(screen.getAllByTestId('ledger-row')).toHaveLength(2);
      },
    },
    {
      name: 'Queue health',
      Panel: QueuePanel,
      ready: { '/v1/queue/stats': () => json(QUEUE) },
      empty: {
        '/v1/queue/stats': () =>
          json({
            counts: { queued: 0, running: 0, failed: 0, succeeded: 0, dead: 0 },
            oldestRunnableAgeSeconds: null,
            recentDeadLetters: [],
          }),
      },
      path: '/v1/queue/stats',
      emptyText: /no jobs/,
      readyCheck: () => {
        expect(screen.getByTestId('queue-count-queued')).toHaveTextContent('2');
        expect(screen.getByTestId('queue-oldest')).toHaveTextContent('42 s');
        expect(screen.getByTestId('dead-letter')).toHaveTextContent('always fails');
      },
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      const region = () => screen.getByRole('region', { name: c.name });

      it('loading: a status message while the request is in flight', async () => {
        stubApi({ [c.path]: never });
        render(<c.Panel apiKey="k" onUnauthorized={noop} />);
        expect(within(region()).getByRole('status')).toHaveTextContent(/Loading/);
        expect(region()).toHaveAttribute('data-state', 'loading');
      });

      it('empty: says so in words', async () => {
        stubApi(c.empty);
        render(<c.Panel apiKey="k" onUnauthorized={noop} />);
        expect(await within(region()).findByText(c.emptyText)).toBeInTheDocument();
        expect(region()).toHaveAttribute('data-state', 'ready');
      });

      it('error: an alert with the reason and a retry that works', async () => {
        let fail = true;
        stubApi({
          ...c.ready,
          [c.path]: (u) => (fail ? errorBody(500, 'database is down') : c.ready[c.path]!(u)),
        });
        render(<c.Panel apiKey="k" onUnauthorized={noop} />);
        const alert = await within(region()).findByRole('alert');
        expect(alert).toHaveTextContent(/Could not load/);
        expect(alert).toHaveTextContent('database is down');
        fail = false;
        await userEvent.click(within(region()).getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(region()).toHaveAttribute('data-state', 'ready'));
        c.readyCheck();
      });

      it('unauthorized: a distinct message, and the app is told', async () => {
        stubApi({ [c.path]: () => errorBody(401, 'Missing or invalid API key') });
        const onUnauthorized = vi.fn();
        render(<c.Panel apiKey="bad" onUnauthorized={onUnauthorized} />);
        const alert = await within(region()).findByRole('alert');
        expect(alert).toHaveTextContent(/Unauthorized/);
        expect(region()).toHaveAttribute('data-state', 'unauthorized');
        await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
      });

      it('ready: shows the numbers, sends the key as a bearer header', async () => {
        const calls = stubApi(c.ready);
        render(<c.Panel apiKey="secret-key-123" onUnauthorized={noop} />);
        await waitFor(() => expect(region()).toHaveAttribute('data-state', 'ready'));
        c.readyCheck();
        expect(calls.every((x) => x.auth === 'Bearer secret-key-123')).toBe(true);
      });
    });
  }

  it('the usage chart is a labelled image with a data table, not colour alone', async () => {
    stubApi({ '/v1/usage/summary': () => json(USAGE) });
    render(<UsagePanel apiKey="k" onUnauthorized={noop} />);
    const img = await screen.findByRole('img');
    expect(img).toHaveAccessibleName(
      /Bar chart of daily usage quantity from 2026-09-01 to 2026-09-05; total 2,000/,
    );
    expect(screen.getByText('Show the data as a table')).toBeInTheDocument();
    // days without events appear as zero rows, so gaps are visible
    expect(screen.getByRole('rowheader', { name: '2026-09-02' })).toBeInTheDocument();
  });

  it('ledger amounts carry a sign and a text hint, not only a colour', async () => {
    stubApi({
      '/v1/credits/balance': () => json(BALANCE),
      '/v1/credits/ledger': () => json(LEDGER),
    });
    render(<BalancePanel apiKey="k" onUnauthorized={noop} />);
    const rows = await screen.findAllByTestId('ledger-row');
    expect(rows[0]).toHaveTextContent('−1,800');
    expect(rows[0]).toHaveTextContent('(spent)');
    expect(rows[1]).toHaveTextContent('+5,000');
    expect(rows[1]).toHaveTextContent('(added)');
  });
});

describe('the API key handling', () => {
  it('is entered in a labelled password field and never stored or put in the URL', async () => {
    const calls = stubApi({
      '/v1/usage/summary': () => json(USAGE),
      '/v1/credits/balance': () => json(BALANCE),
      '/v1/credits/ledger': () => json(LEDGER),
      '/v1/queue/stats': () => json(QUEUE),
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const before = window.location.href;
    render(<App />);
    const field = screen.getByLabelText('Tenant API key');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    await userEvent.type(field, 'lk_test_super-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('region', { name: 'Queue health' })).toHaveAttribute(
      'data-state',
      'ready',
    );
    expect(calls.length).toBe(4);
    expect(calls.every((c) => c.auth === 'Bearer lk_test_super-secret')).toBe(true);
    expect(calls.every((c) => !c.url.includes('lk_test'))).toBe(true);
    // nowhere persistent
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(window.location.href).toBe(before);
    expect(document.body.innerHTML).not.toContain('lk_test_super-secret');
  });

  it('sign out removes the key and the data', async () => {
    stubApi({
      '/v1/usage/summary': () => json(USAGE),
      '/v1/credits/balance': () => json(BALANCE),
      '/v1/credits/ledger': () => json(LEDGER),
      '/v1/queue/stats': () => json(QUEUE),
    });
    render(<App />);
    await userEvent.type(screen.getByLabelText('Tenant API key'), 'lk_abc');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('button', { name: 'Sign out' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(screen.getByLabelText('Tenant API key')).toHaveValue('');
    expect(screen.queryByTestId('balance')).not.toBeInTheDocument();
  });

  it('a rejected key shows unauthorized in every panel and a banner', async () => {
    stubApi({
      '/v1/usage/summary': () => errorBody(401, 'nope'),
      '/v1/credits/balance': () => errorBody(401, 'nope'),
      '/v1/credits/ledger': () => errorBody(401, 'nope'),
      '/v1/queue/stats': () => errorBody(401, 'nope'),
    });
    render(<App />);
    await userEvent.type(screen.getByLabelText('Tenant API key'), 'lk_wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      for (const id of ['usage', 'balance', 'queue']) {
        expect(screen.getByTestId(id)).toHaveAttribute('data-state', 'unauthorized');
      }
    });
    expect(
      screen.getAllByRole('alert').some((a) => /key was not accepted/.test(a.textContent ?? '')),
    ).toBe(true);
  });
});
