import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, runAgent } from '../agent/index.js';
import { LLMError } from '../llm/errors.js';
import { OpenAICompatibleProvider } from '../llm/openai.js';
import { runSmoke } from '../llm/smoke.js';
import {
  chunk,
  completion,
  json,
  sseData,
  sseStart,
  startMock,
  type MockServer,
} from '../llm/testing/mock-server.js';
import { ManualClock } from '../llm/types.js';
import {
  DecryptionError,
  Keyring,
  SecretConfigError,
  decryptSecret,
  encryptSecret,
  generateKey,
  needsRotation,
  reencryptSecret,
} from './crypto.js';
import { classifyAddress, parseIPv4, parseIPv6 } from './ip.js';
import { redactingLogger } from './redact.js';
import { createSafeFetch, type RequestImpl } from './safe-fetch.js';
import { SafeFetchError, validateUrl, type UrlRejectionCode } from './url.js';

const KEY = 'sk-test-SSRFKEY0123456789abcdef';
let servers: MockServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});
const mock = async (h: Parameters<typeof startMock>[0]): Promise<MockServer> => {
  const s = await startMock(h);
  servers.push(s);
  return s;
};
const reject = (fn: () => unknown): SafeFetchError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SafeFetchError);
    return e as SafeFetchError;
  }
  throw new Error('expected a rejection');
};
const rejectAsync = async (p: Promise<unknown>): Promise<SafeFetchError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(SafeFetchError);
  return e as SafeFetchError;
};

// ---------------------------------------------------------------------------------------------
describe('IP address classification (every range)', () => {
  const blocked: [string, string][] = [
    // IPv4
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.127.255.255', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local'],
    ['169.254.0.1', 'link-local'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.0.1', 'private'],
    ['192.168.255.255', 'private'],
    ['192.0.0.1', 'IETF'],
    ['192.0.2.1', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.1', 'documentation'],
    ['203.0.113.1', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    // IPv6
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped'],
    ['::ffff:8.8.8.8', 'IPv4-mapped'],
    ['::ffff:7f00:1', 'IPv4-mapped'],
    ['0:0:0:0:0:ffff:a00:1', 'IPv4-mapped'],
    ['::7f00:1', 'IPv4-compatible'],
    ['64:ff9b::7f00:1', 'NAT64'],
    ['100::1', 'discard'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'documentation'],
    ['2002:7f00:1::1', '6to4'],
    ['fc00::1', 'unique local'],
    ['fd12:3456:789a::1', 'unique local'],
    ['fd00:ec2::254', 'unique local'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'multicast'],
    ['ff00::', 'multicast'],
    ['4000::1', 'outside global'],
  ];
  it.each(blocked)('%s is refused (%s)', (ip, category) => {
    const c = classifyAddress(ip);
    expect(c.allowed).toBe(false);
    expect(c.category.toLowerCase()).toContain(category.toLowerCase().split(' ')[0]!);
  });

  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '169.253.255.255',
    '192.167.255.255',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.1',
    '223.255.255.255',
    '11.0.0.1',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '2a00:1450:4001:81b::200e',
    '2001:1::1',
  ];
  it.each(allowed)('%s is public and allowed (boundary and ordinary addresses)', (ip) => {
    expect(classifyAddress(ip)).toMatchObject({ allowed: true, category: 'public' });
  });

  it('refuses things that are not addresses', () => {
    for (const s of [
      '',
      'example.com',
      '1.2.3',
      '256.0.0.1',
      '01.2.3.4',
      '1.2.3.4.5',
      '::g',
      'fe80::1%eth0',
      ':::',
      '1:2:3:4:5:6:7:8:9',
    ]) {
      expect(classifyAddress(s).allowed, s).toBe(false);
    }
    expect(parseIPv4('127.0.0.1')).toBe(2130706433n);
    expect(parseIPv4('0177.0.0.1')).toBeNull();
    expect(parseIPv6('::ffff:1.2.3.4')).toBe(0xffff01020304n);
    expect(parseIPv6('[::1]')).toBe(1n);
  });
});

// ---------------------------------------------------------------------------------------------
describe('URL validation', () => {
  it.each([
    ['https://api.example.com/v1', 'ok'],
    ['https://api.example.com:8443/v1/', 'ok'],
    ['https://API.Example.COM/v1', 'ok'],
    ['https://8.8.8.8/v1', 'ok'],
    ['https://[2606:4700:4700::1111]/v1', 'ok'],
    ['https://api.example.com./v1', 'ok'], // trailing dot: normalised
    ['http://api.example.com/v1', 'insecure_http'],
    ['http://8.8.8.8/v1', 'insecure_http'],
    ['ftp://api.example.com', 'bad_scheme'],
    ['file:///etc/passwd', 'bad_scheme'],
    ['javascript:alert(1)', 'bad_scheme'],
    ['data:text/plain,hi', 'bad_scheme'],
    ['gopher://example.com', 'bad_scheme'],
    ['ws://example.com', 'bad_scheme'],
    ['https://user:pw@api.example.com/v1', 'credentials_in_url'],
    ['https://user@api.example.com/v1', 'credentials_in_url'],
    ['https://:pw@api.example.com/v1', 'credentials_in_url'],
    ['https://api.example.com/v1#frag', 'fragment_in_url'],
    ['', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['https://', 'invalid_url'],
    ['https://api.example.com/v1\nHost: evil', 'invalid_url'],
    ['https://api.example .com', 'invalid_url'],
    ['https://' + 'a'.repeat(63) + '.com/' + 'p'.repeat(2100), 'too_long'],
    // 127.0.0.1 in every encoding
    ['https://127.0.0.1', 'blocked_address'],
    ['https://127.0.0.1:8080/v1', 'blocked_address'],
    ['https://2130706433', 'blocked_address'], // decimal
    ['https://0x7f000001', 'blocked_address'], // hex
    ['https://0x7f.0.0.1', 'blocked_address'], // dotted hex
    ['https://0177.0.0.1', 'blocked_address'], // octal
    ['https://017700000001', 'blocked_address'], // full octal
    ['https://127.1', 'blocked_address'], // short
    ['https://127.0.1', 'blocked_address'],
    ['https://127.0.0.1.', 'blocked_address'], // trailing dot
    ['https://0', 'blocked_address'],
    ['https://0.0.0.0', 'blocked_address'],
    ['https://[::1]', 'blocked_address'],
    ['https://[0:0:0:0:0:0:0:1]', 'blocked_address'],
    ['https://[::]', 'blocked_address'],
    ['https://[::ffff:127.0.0.1]', 'blocked_address'], // IPv4-mapped
    ['https://[0:0:0:0:0:ffff:7f00:1]', 'blocked_address'],
    ['https://[::ffff:7f00:1]', 'blocked_address'],
    // localhost variants
    ['https://localhost', 'blocked_name'],
    ['https://LOCALHOST', 'blocked_name'],
    ['https://localhost.', 'blocked_name'],
    ['https://LocalHost:8443/v1', 'blocked_name'],
    ['https://foo.localhost', 'blocked_name'],
    ['https://a.b.localhost', 'blocked_name'],
    ['https://localhost.localdomain', 'blocked_name'],
    ['https://ip6-localhost', 'blocked_name'],
    ['http://localhost:11434/v1', 'blocked_name'], // the dev flag is off
    // cloud metadata and internal names
    ['https://169.254.169.254/latest/meta-data/', 'blocked_address'],
    ['https://[fd00:ec2::254]/', 'blocked_address'],
    ['https://metadata.google.internal/computeMetadata/v1/', 'blocked_name'],
    ['https://metadata/', 'blocked_name'],
    ['https://db.internal', 'blocked_name'],
    ['https://printer.local', 'blocked_name'],
    ['https://intranet', 'blocked_name'],
    ['https://corp-gitlab', 'blocked_name'],
    ['https://router.home.arpa', 'blocked_name'],
    // private ranges
    ['https://10.0.0.1', 'blocked_address'],
    ['https://172.16.0.1', 'blocked_address'],
    ['https://172.31.255.255', 'blocked_address'],
    ['https://192.168.1.1', 'blocked_address'],
    ['https://100.64.0.1', 'blocked_address'],
    ['https://198.18.0.1', 'blocked_address'],
    ['https://224.0.0.1', 'blocked_address'],
    ['https://255.255.255.255', 'blocked_address'],
    ['https://[fc00::1]', 'blocked_address'],
    ['https://[fe80::1]', 'blocked_address'],
    ['https://[ff02::1]', 'blocked_address'],
    ['https://[2001:db8::1]', 'blocked_address'],
    ['https://[::ffff:10.0.0.1]', 'blocked_address'],
    ['https://[64:ff9b::a00:1]', 'blocked_address'],
    ['https://172.15.255.255', 'ok'], // just outside 172.16/12
    ['https://172.32.0.1', 'ok'],
  ] satisfies [string, UrlRejectionCode | 'ok'][])('%s -> %s', (url, expected) => {
    if (expected === 'ok') expect(validateUrl(url).url.protocol).toBe('https:');
    else expect(reject(() => validateUrl(url)).code).toBe(expected);
  });

  it('normalises: lowercase host, trailing dot removed, brackets removed', () => {
    expect(validateUrl('https://API.Example.COM./v1').hostname).toBe('api.example.com');
    expect(validateUrl('https://[2606:4700:4700::1111]/x').hostname).toBe('2606:4700:4700::1111');
    expect(validateUrl('https://8.8.8.8/x').ip).toBe('8.8.8.8');
  });

  it('http and loopback are allowed ONLY with the server-side dev flag, and only for loopback', () => {
    const dev = { allowInsecureLocalhost: true };
    for (const u of [
      'http://localhost:11434/v1',
      'http://LOCALHOST/v1',
      'http://localhost./v1',
      'http://foo.localhost/v1',
      'http://127.0.0.1:8080/v1',
      'http://[::1]:8080/v1',
      'https://localhost/v1',
      'http://127.1/v1',
      'http://2130706433/v1',
    ]) {
      expect(validateUrl(u, dev).devLoopback, u).toBe(true);
    }
    // the flag does not open anything else
    for (const [u, code] of [
      ['http://example.com/v1', 'insecure_http'],
      ['http://localhost.evil.com/v1', 'insecure_http'],
      ['https://10.0.0.1', 'blocked_address'],
      ['http://192.168.1.1', 'blocked_address'],
      ['https://169.254.169.254', 'blocked_address'],
      ['https://[::ffff:127.0.0.1]', 'blocked_address'],
      ['https://metadata.google.internal', 'blocked_name'],
      ['https://db.internal', 'blocked_name'],
    ] as const) {
      expect(reject(() => validateUrl(u, dev)).code, u).toBe(code);
    }
  });

  it('the dev flag cannot come from the URL, a request or a stored config: it is only a property of the server-built policy object', () => {
    // nothing in the URL string or in a "user setting" shaped object changes the outcome
    const userSettings = { allowInsecureLocalhost: true, baseURL: 'http://localhost:11434/v1' };
    expect(reject(() => validateUrl(userSettings.baseURL)).code).toBe('blocked_name'); // validateUrl takes the policy as a separate server argument
    expect(reject(() => validateUrl('http://localhost/v1?allowInsecureLocalhost=true')).code).toBe(
      'blocked_name',
    );
  });

  it('host allow and deny hooks, and the maximum URL length', () => {
    expect(
      reject(() =>
        validateUrl('https://api.example.com', { hostDenylist: (h) => h.endsWith('example.com') }),
      ).code,
    ).toBe('host_denied');
    expect(
      reject(() =>
        validateUrl('https://api.other.com', { hostAllowlist: (h) => h === 'api.example.com' }),
      ).code,
    ).toBe('host_not_allowed');
    expect(
      validateUrl('https://api.example.com', { hostAllowlist: (h) => h === 'api.example.com' })
        .hostname,
    ).toBe('api.example.com');
    expect(
      reject(() => validateUrl('https://a.example.com/' + 'x'.repeat(50), { maxUrlLength: 40 }))
        .code,
    ).toBe('too_long');
  });

  it('error messages never contain the credentials or the query string of the URL', () => {
    const e1 = reject(() =>
      validateUrl(
        'https://admin:SUPERSECRETPW@api.example.com/v1?api_key=sk-LEAKME0123456789abcdef',
      ),
    );
    expect(e1.message).not.toContain('SUPERSECRETPW');
    expect(e1.message).not.toContain('LEAKME');
    const e2 = reject(() => validateUrl('https://10.0.0.1/v1?api_key=sk-LEAKME0123456789abcdef'));
    expect(e2.message).not.toContain('LEAKME');
    expect(JSON.stringify(e2)).not.toContain('LEAKME');
  });
});

// ---------------------------------------------------------------------------------------------
describe('safe fetch: DNS, pinning, redirects, limits (against local servers; no internet)', () => {
  const init = (extra: Record<string, string> = {}) => ({
    method: 'GET',
    headers: extra,
    signal: new AbortController().signal,
  });

  it('with the dev flag OFF a local server is refused and receives no request at all', async () => {
    const s = await mock((_r, res) => json(res, 200, { ok: true }));
    const f = createSafeFetch({});
    expect((await rejectAsync(f(`${s.url}/v1`, init()))).code).toBe('blocked_address');
    expect((await rejectAsync(f(`https://127.0.0.1:${s.port}/v1`, init()))).code).toBe(
      'blocked_address',
    );
    expect(s.requests).toHaveLength(0);
  });

  it('with the dev flag on, loopback works, with the original Host header, and the name is resolved once', async () => {
    const s = await mock((r, res) => json(res, 200, { host: r.headers.host }));
    let lookups = 0;
    const f = createSafeFetch({
      allowInsecureLocalhost: true,
      resolve: async () => (lookups++, ['127.0.0.1']),
    });
    const r = await f(`http://localhost:${s.port}/v1/x`, init());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ host: `localhost:${s.port}` });
    expect(lookups).toBe(1);
  });

  it('a host name that resolves to a private address is refused before any connection', async () => {
    let connected = 0;
    const spy: RequestImpl = () => {
      connected++;
      throw new Error('should not connect');
    };
    for (const addr of [
      '10.0.0.5',
      '192.168.1.10',
      '169.254.169.254',
      '127.0.0.1',
      'fd00::1',
      '::1',
      '::ffff:10.0.0.1',
      'fe80::1',
      '100.64.0.9',
    ]) {
      const f = createSafeFetch({ resolve: async () => [addr], requestImpl: spy });
      const e = await rejectAsync(f('https://innocent.example.com/v1', init()));
      expect(e.code, addr).toBe('blocked_address');
      expect(e.message).toContain('innocent.example.com');
    }
    expect(connected).toBe(0);
  });

  it('a mixed answer (one public, one private address) is refused, whichever comes first', async () => {
    const spy: RequestImpl = () => {
      throw new Error('should not connect');
    };
    for (const answer of [
      ['93.184.216.34', '10.0.0.5'],
      ['10.0.0.5', '93.184.216.34'],
      ['2606:4700:4700::1111', 'fd00::1'],
    ]) {
      const f = createSafeFetch({ resolve: async () => answer, requestImpl: spy });
      expect((await rejectAsync(f('https://api.example.test/v1', init()))).code).toBe(
        'blocked_address',
      );
    }
  });

  it('DNS rebinding: first answer public, second private. The connection goes to the validated public address, the name is not looked up again, Host and TLS name stay', async () => {
    const s = await mock((r, res) => json(res, 200, { host: r.headers.host }));
    const answers = [['93.184.216.34'], ['10.0.0.5']];
    let lookups = 0;
    const seen: {
      host?: string | null;
      servername?: string;
      hostHeader?: unknown;
      lookupResult?: string;
    }[] = [];
    const spy: RequestImpl = (opts, cb) => {
      let lookupResult = '';
      (opts as { lookup: (h: string, o: object, cb: (e: null, a: string) => void) => void }).lookup(
        'api.example.test',
        {},
        (_e, a) => (lookupResult = a),
      );
      seen.push({
        host: opts.host,
        servername: opts.servername,
        hostHeader: (opts.headers as Record<string, string>).host,
        lookupResult,
      });
      // the test then talks to the local server instead of the "public" address
      return http.request(
        {
          ...opts,
          protocol: 'http:',
          host: '127.0.0.1',
          port: s.port,
          lookup: undefined,
        } as http.RequestOptions,
        cb,
      );
    };
    const f = createSafeFetch({ resolve: async () => answers[lookups++]!, requestImpl: spy });
    const r = await f('https://api.example.test/v1/chat', init());
    expect(await r.json()).toEqual({ host: 'api.example.test' });
    expect(lookups).toBe(1); // one resolution per request: there is no second answer to be fooled by
    expect(seen).toEqual([
      {
        host: '93.184.216.34',
        servername: 'api.example.test',
        hostHeader: 'api.example.test',
        lookupResult: '93.184.216.34',
      },
    ]);
    // the next request resolves again (now private) and is refused
    expect((await rejectAsync(f('https://api.example.test/v1/chat', init()))).code).toBe(
      'blocked_address',
    );
    expect(seen).toHaveLength(1);
  });

  it('a non-default port is part of the Host header; an IP literal gets no TLS server name', async () => {
    const seen: { servername?: string; host?: unknown }[] = [];
    const spy: RequestImpl = (opts) => {
      seen.push({
        servername: opts.servername,
        host: (opts.headers as Record<string, string>).host,
      });
      throw new Error('stop');
    };
    const f = createSafeFetch({ resolve: async () => ['93.184.216.34'], requestImpl: spy });
    await f('https://api.example.test:8443/x', init()).catch(() => undefined);
    await f('https://8.8.4.4/x', init()).catch(() => undefined);
    expect(seen).toEqual([
      { servername: 'api.example.test', host: 'api.example.test:8443' },
      { servername: undefined, host: '8.8.4.4' },
    ]);
  });

  it('a DNS failure and an empty answer are typed', async () => {
    expect(
      (
        await rejectAsync(
          createSafeFetch({
            resolve: async () => {
              throw new Error('ENOTFOUND');
            },
          })('https://nope.example.test/', init()),
        )
      ).code,
    ).toBe('dns_failed');
    expect(
      (
        await rejectAsync(
          createSafeFetch({ resolve: async () => [] })('https://nope.example.test/', init()),
        )
      ).code,
    ).toBe('dns_no_address');
  });

  it('does not follow redirects by default', async () => {
    const s = await mock((_r, res) => {
      res.writeHead(302, { location: 'https://10.0.0.5/secret' });
      res.end();
    });
    const f = createSafeFetch({ allowInsecureLocalhost: true });
    expect((await rejectAsync(f(`${s.url}/v1`, init()))).code).toBe('redirect_blocked');
  });

  it('with redirects allowed, EVERY hop is re-validated: a redirect to a private address, to metadata, to http, to a name that resolves privately', async () => {
    for (const target of [
      'https://10.0.0.5/secret',
      'https://169.254.169.254/latest/meta-data',
      'http://example.com/plain',
      'https://rebind.example.test/x',
    ]) {
      const s = await mock((_r, res) => {
        res.writeHead(302, { location: target });
        res.end();
      });
      const f = createSafeFetch({
        allowInsecureLocalhost: true,
        maxRedirects: 3,
        resolve: async (h) => (h === 'rebind.example.test' ? ['192.168.0.9'] : ['93.184.216.34']),
      });
      const e = await rejectAsync(f(`${s.url}/v1`, init()));
      expect(['blocked_address', 'insecure_http']).toContain(e.code);
    }
  });

  it('follows a safe redirect, caps the number of hops, and strips credentials when the origin changes', async () => {
    const other = await mock((r, res) =>
      json(res, 200, { auth: r.headers.authorization ?? null, path: r.url }),
    );
    const same = await mock((r, res) => {
      if (r.url === '/start') {
        res.writeHead(302, { location: '/next' });
        return res.end();
      }
      if (r.url === '/next') {
        res.writeHead(302, { location: `${other.url}/final` });
        return res.end();
      }
      if (r.url === '/loop') {
        res.writeHead(302, { location: '/loop' });
        return res.end();
      }
      json(res, 200, { auth: r.headers.authorization ?? null });
    });
    const f = createSafeFetch({ allowInsecureLocalhost: true, maxRedirects: 3 });
    const r = await f(`${same.url}/start`, init({ Authorization: `Bearer ${KEY}` }));
    expect(await r.json()).toEqual({ auth: null, path: '/final' }); // crossed to another origin: no Authorization
    expect(same.requests[1]!.headers.authorization).toBe(`Bearer ${KEY}`); // the same-origin hop kept it
    expect(other.requests[0]!.headers.authorization).toBeUndefined();
    expect((await rejectAsync(f(`${same.url}/loop`, init()))).code).toBe('too_many_redirects');
  });

  it('an oversized response is refused: declared length, plain body and a stream', async () => {
    const big = await mock((_r, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': '3000000',
      });
      res.end(Buffer.alloc(3_000_000, 97));
    });
    const f = createSafeFetch({ allowInsecureLocalhost: true, maxResponseBytes: 100_000 });
    expect((await rejectAsync(f(`${big.url}/`, init()))).code).toBe('response_too_large'); // Content-Length says so up front
    const chunked = await mock(async (_r, res) => {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      for (let i = 0; i < 100; i++) {
        res.write(Buffer.alloc(10_000, 97));
        await new Promise((r) => setTimeout(r, 1));
      }
      res.end();
    });
    const r = await f(`${chunked.url}/`, init());
    const e = await r.arrayBuffer().then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(SafeFetchError);
    expect((e as SafeFetchError).code).toBe('response_too_large');
  });

  it('a server that never answers hits the total timeout; one that drips a body is cut at the total timeout', async () => {
    const hang = await mock(() => undefined);
    const f = createSafeFetch({ allowInsecureLocalhost: true, totalTimeoutMs: 200 });
    const t0 = Date.now();
    expect((await rejectAsync(f(`${hang.url}/`, init()))).code).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(2500);
    const drip = await mock(async (_r, res) => {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      for (let i = 0; i < 100; i++) {
        res.write('x');
        await new Promise((r) => setTimeout(r, 30));
      }
      res.end();
    });
    const r = await f(`${drip.url}/`, init());
    const e = await r.text().then(
      () => undefined,
      (x: unknown) => x,
    );
    expect((e as SafeFetchError).code).toBe('timeout');
  });

  it('a connection that never completes hits the connect timeout', async () => {
    const spy: RequestImpl = () => {
      const req = Object.assign(new EventEmitter(), {
        write() {},
        end() {},
        destroy(e?: Error) {
          if (e) setImmediate(() => req.emit('error', e));
        },
      });
      setImmediate(() =>
        req.emit('socket', Object.assign(new EventEmitter(), { connecting: true })),
      );
      return req as unknown as http.ClientRequest;
    };
    const f = createSafeFetch({
      resolve: async () => ['93.184.216.34'],
      requestImpl: spy,
      connectTimeoutMs: 60,
    });
    expect((await rejectAsync(f('https://api.example.test/', init()))).code).toBe(
      'connect_timeout',
    );
  });

  it('honors an AbortSignal', async () => {
    const hang = await mock(() => undefined);
    const f = createSafeFetch({ allowInsecureLocalhost: true });
    const ac = new AbortController();
    const p = f(`${hang.url}/`, { method: 'GET', headers: {}, signal: ac.signal }).then(
      () => undefined,
      (e: unknown) => e,
    );
    setTimeout(() => ac.abort(), 50);
    expect(((await p) as Error).name).toBe('AbortError');
  });
});

// ---------------------------------------------------------------------------------------------
describe('the adapter on top of the safe fetch', () => {
  it('chat and streaming work through it (dev flag, loopback mock)', async () => {
    const s = await mock((r, res) => {
      const body = JSON.parse(r.body) as { stream?: boolean };
      if (body.stream) {
        sseStart(res);
        return res.end(
          sseData(chunk({ content: 'hi' })) + sseData(chunk({}, 'stop')) + 'data: [DONE]\n\n',
        );
      }
      json(res, 200, completion({ content: 'hello' }));
    });
    const provider = new OpenAICompatibleProvider({
      baseURL: `${s.url}/v1`,
      apiKey: KEY,
      model: 'm',
      fetch: createSafeFetch({ allowInsecureLocalhost: true }),
    });
    expect((await provider.chat({ messages: [{ role: 'user', content: 'x' }] })).content).toBe(
      'hello',
    );
    const events = [];
    for await (const e of provider.stream({ messages: [{ role: 'user', content: 'x' }] }))
      events.push(e.type);
    expect(events).toContain('done');
  });

  it('a refused URL becomes a bad_request LLMError, is not retried, and carries no key or credentials', async () => {
    for (const baseURL of [
      'https://10.0.0.5/v1',
      'https://user:PWSECRET@api.example.com/v1',
      'http://api.example.com/v1',
      'https://api.example.com/v1?key=' + KEY,
    ]) {
      const provider = new OpenAICompatibleProvider({
        baseURL,
        apiKey: KEY,
        model: 'm',
        fetch: createSafeFetch({ resolve: async () => ['10.1.1.1'] }),
        clock: new ManualClock(),
      });
      const e = (await provider.chat({ messages: [{ role: 'user', content: 'x' }] }).then(
        () => undefined,
        (x: unknown) => x,
      )) as LLMError;
      expect(e).toBeInstanceOf(LLMError);
      expect(e.kind).toBe('bad_request');
      for (const secret of [KEY, 'PWSECRET', 'SSRFKEY']) {
        expect(e.message).not.toContain(secret);
        expect(JSON.stringify(e)).not.toContain(secret);
      }
    }
  });

  it('the key never appears in an error, a run trace, the smoke output or a log line, even when the server echoes it', async () => {
    const s = await mock((r, res) => {
      const echo = `server saw ${String(r.headers.authorization)}`;
      if (r.body.includes('"stream":true')) {
        sseStart(res);
        return res.end(
          sseData(chunk({ content: echo })) + sseData(chunk({}, 'stop')) + 'data: [DONE]\n\n',
        );
      }
      if (r.body.includes('fail-please')) return json(res, 500, { error: { message: echo } });
      if (r.body.includes('"tools"') && !r.body.includes('"role":"tool"'))
        return json(
          res,
          200,
          completion(
            {
              content: null,
              tool_calls: [
                { id: 't', type: 'function', function: { name: 'leak', arguments: '{}' } },
              ],
            },
            'tool_calls',
          ),
        );
      json(res, 200, completion({ content: echo }));
    });
    const fetch = createSafeFetch({ allowInsecureLocalhost: true });
    const provider = new OpenAICompatibleProvider({
      baseURL: `${s.url}/v1`,
      apiKey: KEY,
      model: 'm',
      fetch,
      maxRetries: 0,
    });
    // error path
    const err = (await provider.chat({ messages: [{ role: 'user', content: 'fail-please' }] }).then(
      () => undefined,
      (x: unknown) => x,
    )) as LLMError;
    expect(err.kind).toBe('server_error');
    expect(JSON.stringify(err) + err.message).not.toContain('SSRFKEY');
    // agent trace path: a tool that returns the key, and a failing tool
    const leak = defineTool({
      name: 'leak',
      description: 'x',
      parameters: z.object({}),
      execute: () => `the key is ${KEY}`,
    });
    const run = await runAgent({
      provider,
      prompt: 'x',
      tools: [leak],
      debug: true,
      secrets: [KEY],
    });
    expect(JSON.stringify(run.trace)).not.toContain('SSRFKEY');
    expect(JSON.stringify(run.trace)).not.toContain(KEY);
    const failing = await runAgent({ provider, prompt: 'fail-please', secrets: [KEY] });
    expect(failing.stopReason).toBe('provider_error');
    expect(JSON.stringify(failing)).not.toContain('SSRFKEY');
    // smoke output path
    const smoke = await runSmoke({ baseURL: `${s.url}/v1`, apiKey: KEY, model: 'm' }, { fetch });
    expect(JSON.stringify(smoke)).not.toContain('SSRFKEY');
    // log path
    const lines: string[] = [];
    const log = redactingLogger(
      (l, m, f) => lines.push(`${l} ${m} ${JSON.stringify(f ?? {})}`),
      [KEY],
    );
    log('error', `request failed: ${err.message} with key ${KEY}`, {
      headers: { authorization: `Bearer ${KEY}` },
      url: 'https://u:p4ssw0rd@h.example/v1',
      note: `api_key=${KEY}`,
    });
    expect(lines.join('\n')).not.toMatch(/SSRFKEY|p4ssw0rd/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('encryption of stored provider configs', () => {
  const ring = (id = 'k1', ids: string[] = ['k1']): Keyring =>
    new Keyring(Object.fromEntries(ids.map((i) => [i, Buffer.from(generateKey(), 'base64')])), id);

  it('round-trips, with a random nonce per value, and the stored form holds neither the plaintext nor a key', () => {
    const r = ring();
    const a = encryptSecret(r, KEY);
    const b = encryptSecret(r, KEY);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^lw1\.k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(a).not.toContain('SSRFKEY');
    expect(decryptSecret(r, a)).toBe(KEY);
    expect(decryptSecret(r, b)).toBe(KEY);
    expect(decryptSecret(r, encryptSecret(r, ''))).toBe('');
    expect(decryptSecret(r, encryptSecret(r, 'ключ 🔑'))).toBe('ключ 🔑');
  });

  it('a wrong key, a changed value, a different context and garbage all fail with the same generic error', () => {
    const r = ring();
    const token = encryptSecret(r, KEY, 'config-1');
    const wrong = new Keyring({ k1: Buffer.from(generateKey(), 'base64') }, 'k1'); // same id, different key
    for (const attempt of [
      () => decryptSecret(wrong, token, 'config-1'),
      () => decryptSecret(r, token, 'config-2'), // moved to another row
      () =>
        decryptSecret(
          r,
          // tag changed: the FIRST character of the tag (all 6 bits count; the last character of a base64 tag carries unused bits,
          // so replacing it with "A" was no change at all in about one run in 64)
          token.replace(
            /.([^.]+)$/,
            (_m, tag: string) => `.${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`,
          ),
          'config-1',
        ),
      () =>
        decryptSecret(
          r,
          token.replace(/\.[^.]+\.([^.]+\.[^.]+)$/, '.AAAAAAAAAAAAAAAA.$1'),
          'config-1',
        ), // nonce changed
      () => decryptSecret(r, 'not a token'),
      () => decryptSecret(r, 'lw1.k1.a.b'),
      () =>
        decryptSecret(
          new Keyring({ zz: Buffer.from(generateKey(), 'base64') }, 'zz'),
          token,
          'config-1',
        ), // unknown key id
    ]) {
      let e: unknown;
      try {
        attempt();
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(DecryptionError);
      expect(String((e as Error).message)).not.toContain('SSRFKEY');
    }
  });

  it('key rotation: values written with the old key still decrypt, are flagged, and can be re-encrypted with the new key', () => {
    const k1 = Buffer.from(generateKey(), 'base64');
    const k2 = Buffer.from(generateKey(), 'base64');
    const old = encryptSecret(new Keyring({ k1 }, 'k1'), KEY, 'row');
    const rotated = new Keyring({ k1, k2 }, 'k2');
    expect(decryptSecret(rotated, old, 'row')).toBe(KEY);
    expect(needsRotation(rotated, old)).toBe(true);
    const fresh = reencryptSecret(rotated, old, 'row');
    expect(fresh.startsWith('lw1.k2.')).toBe(true);
    expect(needsRotation(rotated, fresh)).toBe(false);
    // once re-encrypted, the old key can be removed
    expect(decryptSecret(new Keyring({ k2 }, 'k2'), fresh, 'row')).toBe(KEY);
    expect(() => decryptSecret(new Keyring({ k2 }, 'k2'), old, 'row')).toThrow(DecryptionError);
    expect(encryptSecret(rotated, KEY).startsWith('lw1.k2.')).toBe(true);
  });

  it('keys come from the environment; bad configuration is a clear error that does not print key material', () => {
    const k = generateKey();
    const r = Keyring.fromEnv({
      LEDGERWORKS_SECRET_KEYS: `a:${k},b:${generateKey()}`,
      LEDGERWORKS_SECRET_KEY_ID: 'b',
    });
    expect(r.currentId).toBe('b');
    expect(r.ids()).toEqual(['a', 'b']);
    const bad = [
      {},
      { LEDGERWORKS_SECRET_KEYS: `a:${k}` },
      { LEDGERWORKS_SECRET_KEYS: `a:${k}`, LEDGERWORKS_SECRET_KEY_ID: 'missing' },
      {
        LEDGERWORKS_SECRET_KEYS: `a:${Buffer.from('short').toString('base64')}`,
        LEDGERWORKS_SECRET_KEY_ID: 'a',
      },
      { LEDGERWORKS_SECRET_KEYS: `no-colon-here`, LEDGERWORKS_SECRET_KEY_ID: 'a' },
      { LEDGERWORKS_SECRET_KEYS: `bad.id:${k}`, LEDGERWORKS_SECRET_KEY_ID: 'bad.id' },
    ];
    for (const env of bad) {
      let e: unknown;
      try {
        Keyring.fromEnv(env);
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(SecretConfigError);
      expect(String((e as Error).message)).not.toContain(k);
    }
    expect(Buffer.from(generateKey(), 'base64')).toHaveLength(32);
  });
});
