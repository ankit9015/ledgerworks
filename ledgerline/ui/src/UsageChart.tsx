import { fmt } from './components';

export interface Day {
  day: string;
  events: number;
  quantity: number;
}

/** Fills days without events with zeros so gaps are visible as gaps, not skipped. */
export function fillDays(days: Day[], from: string, to: string): Day[] {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const out: Day[] = [];
  const end = Date.parse(to);
  for (let t = Date.UTC(...ymd(from)); t <= end; t += 86400e3) {
    const key = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, events: 0, quantity: 0 });
  }
  return out;
}
function ymd(iso: string): [number, number, number] {
  const d = new Date(iso);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

/**
 * Daily usage as an SVG bar chart. Accessible without colour or sight: the figure has a text
 * summary (role "img" with a label), every bar carries its value in a <title>, the axis shows the
 * maximum and the date range as text, and the full numbers are in a data table below.
 */
export function UsageChart({ days }: { days: Day[] }) {
  const W = 640;
  const H = 180;
  const max = Math.max(1, ...days.map((d) => d.quantity));
  const bw = W / Math.max(1, days.length);
  const total = days.reduce((s, d) => s + d.quantity, 0);
  const first = days[0]?.day ?? '';
  const last = days[days.length - 1]?.day ?? '';
  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${W} ${H + 24}`}
        role="img"
        aria-label={`Bar chart of daily usage quantity from ${first} to ${last}; total ${fmt(total)}; highest day ${fmt(max)}`}
      >
        <line x1="0" y1={H} x2={W} y2={H} stroke="currentColor" />
        {days.map((d, i) => {
          const h = (d.quantity / max) * (H - 8);
          return (
            <rect
              key={d.day}
              x={i * bw + 1}
              y={H - h}
              width={Math.max(1, bw - 2)}
              height={h}
              fill="currentColor"
            >
              <title>{`${d.day}: ${fmt(d.quantity)} units, ${fmt(d.events)} events`}</title>
            </rect>
          );
        })}
        <text x="0" y="12" fontSize="11" fill="currentColor">{`max ${fmt(max)}`}</text>
        <text x="0" y={H + 16} fontSize="11" fill="currentColor">
          {first}
        </text>
        <text x={W} y={H + 16} fontSize="11" fill="currentColor" textAnchor="end">
          {last}
        </text>
      </svg>
      <details>
        <summary>Show the data as a table</summary>
        <table>
          <caption className="sr-only">Daily usage</caption>
          <thead>
            <tr>
              <th scope="col">Day (UTC)</th>
              <th scope="col">Events</th>
              <th scope="col">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.day}>
                <th scope="row">{d.day}</th>
                <td>{fmt(d.events)}</td>
                <td>{fmt(d.quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
