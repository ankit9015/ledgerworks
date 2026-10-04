import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export class McpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpConfigError';
  }
}

export interface McpHttpOptions {
  /** called once per client session: sessions share no state */
  createServer: () => Server;
  /** default 127.0.0.1 */
  host?: string;
  /** default 0 (any free port) */
  port?: number;
  /** REQUIRED bearer token (at least 16 characters). Read it from an environment variable; it is never logged. */
  token: string | undefined;
  /** needed, together with a token, to bind anything other than loopback. Exposing the server publicly is out of scope for now. */
  allowNonLoopback?: boolean;
  /** Origins that may call (browsers send Origin; DNS rebinding comes from the attacker's origin). Default: none, so any request that carries an Origin header is refused. */
  allowedOrigins?: string[];
  /** extra Host header values accepted besides the loopback names with our port */
  allowedHosts?: string[];
  /** default 1 MiB */
  maxBodyBytes?: number;
  /** per client address; default 120 requests per minute */
  rateLimit?: { max: number; windowMs: number };
  maxSessions?: number;
  sessionIdleMs?: number;
  path?: string;
  /** never receives the token or any header value */
  log?: (message: string) => void;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Throws McpConfigError when the options are unsafe. Exported so the rule can be tested without binding a socket. */
export function validateBinding(
  o: Pick<McpHttpOptions, 'host' | 'token' | 'allowNonLoopback'>,
): void {
  const host = o.host ?? '127.0.0.1';
  if (!o.token || o.token.length < 16) {
    throw new McpConfigError(
      'a bearer token of at least 16 characters is required (set it in an environment variable)',
    );
  }
  if (!LOOPBACK.has(host) && o.allowNonLoopback !== true) {
    throw new McpConfigError(
      `refusing to listen on "${host}": only loopback is allowed unless allowNonLoopback is set explicitly (and exposing this server publicly is not supported yet)`,
    );
  }
}

/** Constant-time comparison: both sides are hashed first so the lengths are equal and nothing about the token leaks through timing. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastSeen: number;
}

export interface McpHttpHandle {
  url: string;
  host: string;
  port: number;
  sessions(): number;
  close(): Promise<void>;
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return reject(new BodyTooLarge());
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > max) {
        reject(new BodyTooLarge());
        return; // keep discarding; the caller answers 413 and then closes the connection
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Streamable HTTP MCP server with the security controls this phase requires: loopback by default;
 * a bearer token on every request (constant-time comparison, never logged); Origin and Host header
 * validation against DNS rebinding; a request size limit; a per-client rate limit; a cap on
 * sessions; and one isolated Server per session.
 */
export async function startMcpHttp(o: McpHttpOptions): Promise<McpHttpHandle> {
  validateBinding(o);
  const host = o.host ?? '127.0.0.1';
  const path = o.path ?? '/mcp';
  const maxBody = o.maxBodyBytes ?? 1024 * 1024;
  const limit = o.rateLimit ?? { max: 120, windowMs: 60_000 };
  const maxSessions = o.maxSessions ?? 20;
  const idleMs = o.sessionIdleMs ?? 30 * 60_000;
  const token = o.token!;
  const log = o.log ?? (() => undefined);
  const sessions = new Map<string, Session>();
  const hits = new Map<string, { count: number; windowStart: number }>();
  let port = 0;

  const send = (
    res: http.ServerResponse,
    status: number,
    message: string,
    headers: Record<string, string> = {},
  ): void => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  };

  const server = http.createServer(async (req, res) => {
    const client = req.socket.remoteAddress ?? 'unknown';
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== path) return send(res, 404, 'not found');

      // 1. rate limit per client address (counts every request, so guessing the token is slowed down too)
      const now = Date.now();
      const h = hits.get(client);
      if (!h || now - h.windowStart >= limit.windowMs)
        hits.set(client, { count: 1, windowStart: now });
      else if (++h.count > limit.max) {
        log(`429 ${req.method} ${client}`);
        return send(res, 429, 'rate limit exceeded', {
          'retry-after': String(Math.ceil((h.windowStart + limit.windowMs - now) / 1000)),
        });
      }

      // 2. Host header: a rebinding attack arrives with the attacker's name in Host
      const hostHeader = (req.headers.host ?? '').toLowerCase();
      const okHosts = new Set([
        `127.0.0.1:${port}`,
        `localhost:${port}`,
        `[::1]:${port}`,
        ...(o.allowedHosts ?? []).map((x) => x.toLowerCase()),
      ]);
      if (!okHosts.has(hostHeader)) {
        log(`403 host ${req.method} ${client}`);
        return send(res, 403, 'forbidden host');
      }
      // 3. Origin: browsers always send it; there is no legitimate browser caller by default
      const origin = req.headers.origin;
      if (origin !== undefined && !(o.allowedOrigins ?? []).includes(origin)) {
        log(`403 origin ${req.method} ${client}`);
        return send(res, 403, 'forbidden origin');
      }
      // 4. bearer token
      const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
      if (!m || !safeEqual(m[1]!, token)) {
        log(`401 ${req.method} ${client}`);
        return send(res, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
      }

      // 5. dispatch
      const sid = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sid) ? sid[0] : sid;
      if (req.method === 'POST') {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req, maxBody));
        } catch (e) {
          if (e instanceof BodyTooLarge) {
            res.once('finish', () => req.destroy());
            return send(res, 413, `request body larger than ${maxBody} bytes`, {
              connection: 'close',
            });
          }
          return send(res, 400, 'invalid JSON');
        }
        let s = sessionId ? sessions.get(sessionId) : undefined;
        if (sessionId && !s) return send(res, 404, 'unknown session');
        if (!s) {
          if (!isInitializeRequest(body))
            return send(res, 400, 'a new session must start with an initialize request');
          if (sessions.size >= maxSessions) return send(res, 503, 'too many sessions');
          const srv = o.createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { transport, server: srv, lastSeen: Date.now() });
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) sessions.delete(transport.sessionId);
          };
          await srv.connect(transport);
          s = { transport, server: srv, lastSeen: Date.now() };
        }
        s.lastSeen = Date.now();
        await s.transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        const s = sessionId ? sessions.get(sessionId) : undefined;
        if (!s)
          return send(
            res,
            sessionId ? 404 : 400,
            sessionId ? 'unknown session' : 'missing session id',
          );
        s.lastSeen = Date.now();
        await s.transport.handleRequest(req, res);
        return;
      }
      send(res, 405, 'method not allowed', { allow: 'GET, POST, DELETE' });
    } catch (e) {
      log(`500 ${req.method} ${client} ${(e as Error).name}`);
      send(res, 500, 'internal error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, host, () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  const sweep = setInterval(() => {
    const t = Date.now();
    for (const [id, s] of sessions)
      if (t - s.lastSeen > idleMs) void s.transport.close().finally(() => sessions.delete(id));
    for (const [k, v] of hits) if (t - v.windowStart >= limit.windowMs) hits.delete(k);
  }, 30_000);
  sweep.unref();

  const shownHost = host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${shownHost}:${port}${path}`,
    host,
    port,
    sessions: () => sessions.size,
    async close() {
      clearInterval(sweep);
      await Promise.all(
        [...sessions.values()].map((s) => s.transport.close().catch(() => undefined)),
      );
      sessions.clear();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
