import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { FetchLike } from '../llm/openai.js';
import { classifyAddress } from './ip.js';
import { SafeFetchError, validateUrl, type UrlPolicy } from './url.js';

/** The part of http(s).request that the safe fetch uses; injectable so tests can observe the connection. */
export type RequestImpl = (
  options: http.RequestOptions & { protocol: 'http:' | 'https:'; servername?: string },
  callback: (res: http.IncomingMessage) => void,
) => http.ClientRequest;

export interface SafeFetchConfig extends UrlPolicy {
  /** hostname to addresses; default: the system resolver, all addresses */
  resolve?: (hostname: string) => Promise<string[]>;
  requestImpl?: RequestImpl;
  /** TCP connect, ms. Default 10,000. */
  connectTimeoutMs?: number;
  /** the whole exchange including the body (so also the longest a stream may last), ms. Default 600,000. */
  totalTimeoutMs?: number;
  /** most response bytes read, for plain and streamed bodies. Default 16 MiB. */
  maxResponseBytes?: number;
  /** redirects followed, each fully re-validated. Default 0: a redirect is an error. */
  maxRedirects?: number;
}

const defaultResolve = async (hostname: string): Promise<string[]> => {
  const r = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return r.map((a) => a.address);
};

const defaultRequest: RequestImpl = (options, callback) =>
  options.protocol === 'https:'
    ? https.request(options, callback)
    : http.request(options, callback);

const SENSITIVE_HEADERS = ['authorization', 'cookie', 'x-api-key', 'proxy-authorization'];
const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * A fetch for URLs that users supplied (the OpenAI-compatible adapter takes it as its `fetch`).
 *
 * For every request, and for every redirect hop: the URL is validated (https only, no credentials,
 * no internal names or special-purpose IP literals); the host name is resolved HERE and EVERY
 * address must be public (a mixed answer is refused); the connection is then made to the
 * validated IP address itself, so a second DNS answer between the check and the connection cannot
 * redirect it (DNS rebinding), while the Host header and the TLS server name stay those of the
 * original host. Redirects are not followed unless `maxRedirects` allows it. Connect and total
 * timeouts and a response size limit apply, also to streams. Proxy environment variables are
 * ignored: the connection is direct.
 */
export function createSafeFetch(config: SafeFetchConfig = {}): FetchLike {
  const resolve = config.resolve ?? defaultResolve;
  const request = config.requestImpl ?? defaultRequest;
  const connectTimeoutMs = config.connectTimeoutMs ?? 10_000;
  const totalTimeoutMs = config.totalTimeoutMs ?? 600_000;
  const maxBytes = config.maxResponseBytes ?? 16 * 1024 * 1024;
  const maxRedirects = config.maxRedirects ?? 0;

  async function pinned(
    rawUrl: string,
    init: Parameters<FetchLike>[1],
    hops: number,
  ): Promise<Response> {
    const v = validateUrl(rawUrl, config);
    // resolve once, validate every answer, connect to one of them
    let addresses: string[];
    if (v.ip) addresses = [v.ip];
    else {
      try {
        addresses = await resolve(v.hostname);
      } catch {
        throw new SafeFetchError(
          'dns_failed',
          `the host name "${v.hostname.slice(0, 80)}" could not be resolved`,
        );
      }
      if (addresses.length === 0)
        throw new SafeFetchError(
          'dns_no_address',
          `the host name "${v.hostname.slice(0, 80)}" has no address`,
        );
    }
    for (const a of addresses) {
      const c = classifyAddress(a);
      if (!c.allowed && !(config.allowInsecureLocalhost && c.loopback)) {
        throw new SafeFetchError(
          'blocked_address',
          `"${v.hostname.slice(0, 80)}" resolves to ${a}, which is not allowed (${c.category})`,
        );
      }
    }
    const ip = addresses[0]!;
    const url = v.url;
    const defaultPort = url.protocol === 'https:' ? 443 : 80;
    const port = url.port ? Number(url.port) : defaultPort;
    const hostHeader =
      url.port && Number(url.port) !== defaultPort ? `${url.hostname}:${url.port}` : url.hostname;
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    for (const [k, val] of Object.entries(init.headers)) headers[k.toLowerCase()] = val;
    headers.host = hostHeader;
    if (init.body !== undefined) headers['content-length'] = String(Buffer.byteLength(init.body));

    return new Promise<Response>((resolveResponse, reject) => {
      let settled = false;
      let req: http.ClientRequest | undefined;
      const total: NodeJS.Timeout = setTimeout(
        () =>
          abort(new SafeFetchError('timeout', `the request took longer than ${totalTimeoutMs} ms`)),
        totalTimeoutMs,
      );
      let bodyRef: Readable | undefined;
      let connectTimer: NodeJS.Timeout | undefined;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        fn();
      };
      const abort = (err: Error): void => {
        clearTimeout(total);
        clearTimeout(connectTimer);
        req?.destroy(err);
        bodyRef?.destroy(err);
        finish(() => reject(err));
      };
      if (init.signal.aborted)
        return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      init.signal.addEventListener(
        'abort',
        () => abort(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
      try {
        req = request(
          {
            protocol: url.protocol as 'http:' | 'https:',
            host: ip, // the validated address, not the name
            port,
            method: init.method,
            path: `${url.pathname}${url.search}`,
            headers,
            // TLS: certificate and SNI are checked against the ORIGINAL host name (not for an IP literal)
            servername: v.ip ? undefined : url.hostname,
            agent: false,
            lookup: (_h, _o, cb) => cb(null, ip, ip.includes(':') ? 6 : 4), // belt and braces: any lookup answers with the validated address
          } as http.RequestOptions & { protocol: 'http:' | 'https:'; servername?: string },
          (res) => {
            const status = res.statusCode ?? 0;
            const location = res.headers.location;
            if (status >= 300 && status < 400 && location) {
              res.resume();
              clearTimeout(total);
              if (hops >= maxRedirects) {
                return finish(() =>
                  reject(
                    new SafeFetchError(
                      maxRedirects === 0 ? 'redirect_blocked' : 'too_many_redirects',
                      maxRedirects === 0
                        ? 'the server answered with a redirect, which is not followed'
                        : `more than ${maxRedirects} redirects`,
                    ),
                  ),
                );
              }
              let next: string;
              try {
                next = new URL(location, url).toString();
              } catch {
                return finish(() =>
                  reject(new SafeFetchError('invalid_url', 'the redirect target cannot be parsed')),
                );
              }
              const nextUrl = new URL(next);
              const sameOrigin = nextUrl.origin === url.origin;
              const nextHeaders = { ...init.headers };
              if (!sameOrigin)
                for (const k of Object.keys(nextHeaders))
                  if (SENSITIVE_HEADERS.includes(k.toLowerCase())) delete nextHeaders[k];
              const changeToGet =
                status === 303 || ((status === 301 || status === 302) && init.method === 'POST');
              finish(() => {
                pinned(
                  next,
                  {
                    ...init,
                    method: changeToGet ? 'GET' : init.method,
                    body: changeToGet ? undefined : init.body,
                    headers: nextHeaders,
                  },
                  hops + 1,
                ).then(resolveResponse, reject);
              });
              return;
            }
            const declared = Number(res.headers['content-length']);
            if (Number.isFinite(declared) && declared > maxBytes) {
              res.destroy();
              clearTimeout(total);
              return finish(() =>
                reject(
                  new SafeFetchError(
                    'response_too_large',
                    `the response is larger than ${maxBytes} bytes`,
                  ),
                ),
              );
            }
            let bytes = 0;
            const body = new Readable({ read() {} });
            res.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > maxBytes) {
                const err = new SafeFetchError(
                  'response_too_large',
                  `the response is larger than ${maxBytes} bytes`,
                );
                res.destroy();
                clearTimeout(total);
                body.destroy(err);
                return;
              }
              body.push(chunk);
            });
            res.on('end', () => {
              clearTimeout(total);
              body.push(null);
            });
            res.on('error', (e) => {
              clearTimeout(total);
              body.destroy(e);
            });
            res.on('close', () => {
              if (!res.complete)
                body.destroy(new Error('the connection closed before the response was complete'));
            });
            bodyRef = body; // the total timer also cuts a body that is still streaming
            const h = new Headers();
            for (const [k, val] of Object.entries(res.headers)) {
              if (Array.isArray(val)) for (const x of val) h.append(k, x);
              else if (val !== undefined) h.set(k, val);
            }
            init.signal.addEventListener(
              'abort',
              () => body.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              { once: true },
            );
            finish(() =>
              resolveResponse(
                new Response(
                  NO_BODY.has(status) ? null : (Readable.toWeb(body) as ReadableStream<Uint8Array>),
                  {
                    status,
                    statusText: res.statusMessage ?? '',
                    headers: h,
                  },
                ),
              ),
            );
          },
        );
      } catch (e) {
        return abort(e as Error);
      }
      req.on('error', (e) => abort(e));
      req.on('socket', (socket) => {
        if (socket.connecting) {
          connectTimer = setTimeout(
            () =>
              abort(
                new SafeFetchError(
                  'connect_timeout',
                  `no connection within ${connectTimeoutMs} ms`,
                ),
              ),
            connectTimeoutMs,
          );
          socket.once('connect', () => clearTimeout(connectTimer));
        }
      });
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  }

  return (url, init) => pinned(url, init, 0);
}
