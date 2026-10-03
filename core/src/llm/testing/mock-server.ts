/** A local HTTP server for adapter tests. Never talks to the internet. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type MockHandler = (req: RecordedRequest, res: http.ServerResponse, n: number) => unknown;

export interface MockServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startMock(handler: MockHandler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rec: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(rec);
      Promise.resolve(handler(rec, res, requests.length)).catch(() => res.destroy());
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

export function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
}

export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Starts an SSE response. */
export function sseStart(res: http.ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    ...headers,
  });
}

/** Writes text in pieces of `size` characters, letting the event loop flush between pieces. */
export async function writeSplit(
  res: http.ServerResponse,
  text: string,
  size: number,
): Promise<void> {
  for (let i = 0; i < text.length; i += size) {
    res.write(text.slice(i, i + size));
    await tick();
    await new Promise((r) => setTimeout(r, 2));
  }
}

export const sseData = (obj: unknown): string =>
  `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;

export const chunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
  extra: Record<string, unknown> = {},
): unknown => ({
  id: 'c1',
  object: 'chat.completion.chunk',
  model: 'mock-model',
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

export const completion = (
  message: Record<string, unknown>,
  finish = 'stop',
  usage?: unknown,
): Record<string, unknown> => ({
  id: 'c1',
  object: 'chat.completion',
  model: 'mock-model',
  choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
  ...(usage === undefined ? {} : { usage }),
});
