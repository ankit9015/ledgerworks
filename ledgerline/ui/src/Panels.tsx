import { useMemo, useState } from 'react';
import {
  rangeQuery,
  type Balance,
  type LedgerPage,
  type QueueStats,
  type UsageSummary,
} from './api';
import { Panel, fmt, fmtDate } from './components';
import { UsageChart, fillDays } from './UsageChart';
import { useResource } from './useResource';

interface PanelProps {
  apiKey: string;
  onUnauthorized: () => void;
}

export function UsagePanel({ apiKey, onUnauthorized }: PanelProps) {
  const [days, setDays] = useState(30);
  // The window is fixed when the range is chosen, so the request path is stable between renders.
  const query = useMemo(() => rangeQuery(days), [days]);
  const { state, reload } = useResource<UsageSummary>(
    `/v1/usage/summary?${query}`,
    apiKey,
    onUnauthorized,
  );
  return (
    <Panel
      id="usage"
      title="Usage over time"
      state={state}
      onRetry={reload}
      isEmpty={(d) => d.days.length === 0}
      emptyMessage={`No usage events in the last ${days} days.`}
      actions={
        <label>
          Range{' '}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>last 7 days</option>
            <option value={30}>last 30 days</option>
            <option value={90}>last 90 days</option>
          </select>
        </label>
      }
    >
      {(d) => {
        const events = d.days.reduce((s, x) => s + x.events, 0);
        const quantity = d.days.reduce((s, x) => s + x.quantity, 0);
        return (
          <>
            <dl className="totals">
              <div>
                <dt>Events</dt>
                <dd data-testid="usage-total-events" data-value={events}>
                  {fmt(events)}
                </dd>
              </div>
              <div>
                <dt>Quantity</dt>
                <dd data-testid="usage-total-quantity" data-value={quantity}>
                  {fmt(quantity)}
                </dd>
              </div>
            </dl>
            <UsageChart days={fillDays(d.days, d.from, d.to)} />
          </>
        );
      }}
    </Panel>
  );
}

export function BalancePanel({ apiKey, onUnauthorized }: PanelProps) {
  const balance = useResource<Balance>('/v1/credits/balance', apiKey, onUnauthorized);
  const ledger = useResource<LedgerPage>('/v1/credits/ledger?limit=10', apiKey, onUnauthorized);
  // One panel, two requests: the worst of the two states is shown.
  const state =
    balance.state.status !== 'ready'
      ? balance.state
      : ledger.state.status !== 'ready'
        ? ledger.state
        : ({
            status: 'ready',
            data: { balance: balance.state.data, ledger: ledger.state.data },
          } as const);
  const reload = () => {
    balance.reload();
    ledger.reload();
  };
  return (
    <Panel
      id="balance"
      title="Credit balance"
      state={state}
      onRetry={reload}
      isEmpty={(d) => d.ledger.items.length === 0 && d.balance.balance === 0}
      emptyMessage="This tenant has no credits and no ledger entries yet."
    >
      {(d) => (
        <>
          <p className="big">
            <span className="label">Balance </span>
            <strong data-testid="balance-value" data-value={d.balance.balance}>
              {fmt(d.balance.balance)}
            </strong>{' '}
            credits
          </p>
          {d.ledger.items.length === 0 ? (
            <p role="status" className="state state-empty">
              <span aria-hidden="true">∅ </span>No ledger entries yet.
            </p>
          ) : (
            <table>
              <caption>Recent ledger entries, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Entry</th>
                  <th scope="col">When</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                  <th scope="col" className="num">
                    Balance after
                  </th>
                  <th scope="col">Reference</th>
                </tr>
              </thead>
              <tbody>
                {d.ledger.items.map((e) => (
                  <tr key={e.id} data-testid="ledger-row" data-id={e.id}>
                    <th scope="row">#{e.id}</th>
                    <td>{fmtDate(e.createdAt)}</td>
                    <td>{e.kind}</td>
                    <td className="num">
                      {e.amount > 0 ? `+${fmt(e.amount)}` : `−${fmt(Math.abs(e.amount))}`}{' '}
                      <span className="sr-only">{e.amount > 0 ? '(added)' : '(spent)'}</span>
                    </td>
                    <td className="num">{e.balanceAfter === null ? '—' : fmt(e.balanceAfter)}</td>
                    <td>{e.reference ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Panel>
  );
}

const STATE_LABEL: Record<string, string> = {
  queued: 'Queued (waiting)',
  running: 'Running',
  failed: 'Failed (retry scheduled)',
  succeeded: 'Succeeded',
  dead: 'Dead (retries exhausted)',
};

export function QueuePanel({ apiKey, onUnauthorized }: PanelProps) {
  const { state, reload } = useResource<QueueStats>('/v1/queue/stats', apiKey, onUnauthorized);
  return (
    <Panel
      id="queue"
      title="Queue health"
      state={state}
      onRetry={reload}
      isEmpty={(d) =>
        Object.values(d.counts).every((n) => n === 0) && d.recentDeadLetters.length === 0
      }
      emptyMessage="This tenant has no jobs."
      actions={
        <button type="button" onClick={reload}>
          Refresh
        </button>
      }
    >
      {(d) => (
        <>
          <p>
            <span className="label">Oldest waiting job: </span>
            <strong data-testid="queue-oldest" data-value={d.oldestRunnableAgeSeconds ?? ''}>
              {d.oldestRunnableAgeSeconds === null
                ? 'none waiting'
                : `${Math.round(d.oldestRunnableAgeSeconds)} s`}
            </strong>
          </p>
          <table>
            <caption>Jobs by state</caption>
            <thead>
              <tr>
                <th scope="col">State</th>
                <th scope="col" className="num">
                  Jobs
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(d.counts).map(([s, n]) => (
                <tr key={s}>
                  <th scope="row">{STATE_LABEL[s] ?? s}</th>
                  <td className="num" data-testid={`queue-count-${s}`} data-value={n}>
                    {fmt(n)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>Recent dead letters</h3>
          {d.recentDeadLetters.length === 0 ? (
            <p role="status" className="state state-empty">
              <span aria-hidden="true">∅ </span>No dead letters.
            </p>
          ) : (
            <ul className="dead">
              {d.recentDeadLetters.map((j) => (
                <li key={j.jobId} data-testid="dead-letter">
                  <strong>{j.type}</strong> after {j.attempts} attempts at {fmtDate(j.deadAt)}
                  {j.lastError ? <>: {j.lastError}</> : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}
