import { classifyAddress, parseIPv4, parseIPv6 } from './ip.js';

/**
 * Policy for user-supplied base URLs. It is built by SERVER code (configuration) and passed to
 * the safe fetch once; nothing in a request, a user setting or a stored provider config can change
 * it. In particular `allowInsecureLocalhost` exists only here.
 */
export interface UrlPolicy {
  /** development only: allow http:// and loopback addresses for localhost, 127.0.0.0/8 and ::1. Never from a request. */
  allowInsecureLocalhost?: boolean;
  /** when given, a host must satisfy it */
  hostAllowlist?: (hostname: string) => boolean;
  /** a host for which this returns true is refused */
  hostDenylist?: (hostname: string) => boolean;
  /** longest URL accepted, in characters. Default 2048. */
  maxUrlLength?: number;
}

export type UrlRejectionCode =
  | 'too_long'
  | 'invalid_url'
  | 'bad_scheme'
  | 'credentials_in_url'
  | 'fragment_in_url'
  | 'no_host'
  | 'insecure_http'
  | 'blocked_name'
  | 'blocked_address'
  | 'host_denied'
  | 'host_not_allowed'
  | 'dns_failed'
  | 'dns_no_address'
  | 'redirect_blocked'
  | 'too_many_redirects'
  | 'response_too_large'
  | 'timeout'
  | 'connect_timeout';

/**
 * Thrown for a refused URL or request. The message never repeats the credentials or the query
 * string of the URL: only the host (when it is safe to show) and a reason.
 */
export class SafeFetchError extends Error {
  constructor(
    readonly code: UrlRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}
export { SafeFetchError as UrlRejectedError };

const BLOCKED_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
  '.localdomain',
  '.corp',
  '.private',
];
const BLOCKED_NAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'instance-data',
  'broadcasthost',
]);

/** Names that mean "this machine" and that a development setup may use over http. */
const isLocalhostName = (h: string): boolean => h === 'localhost' || h.endsWith('.localhost');

export interface ValidatedUrl {
  url: URL;
  /** lowercase, no brackets, no trailing dot */
  hostname: string;
  /** set when the host is an IP literal (after the URL parser normalised decimal, hex and octal forms) */
  ip: string | null;
  /** true when this URL is allowed only because of allowInsecureLocalhost */
  devLoopback: boolean;
}

/**
 * Validates a user-supplied URL before any network access: length, scheme (https; http only for
 * localhost under the dev flag), no credentials, no fragment, a real host, no internal names, no
 * special-purpose IP literals, and the host allow/deny hooks. DNS is checked later, at connect time.
 */
export function validateUrl(raw: string, policy: UrlPolicy = {}): ValidatedUrl {
  const max = policy.maxUrlLength ?? 2048;
  if (typeof raw !== 'string' || raw.length === 0)
    throw new SafeFetchError('invalid_url', 'the URL is empty');
  if (raw.length > max)
    throw new SafeFetchError('too_long', `the URL is longer than ${max} characters`);
  const trimmed = raw.trim();
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      throw new SafeFetchError('invalid_url', 'the URL contains control characters');
    }
  }
  if (/\s/.test(trimmed)) throw new SafeFetchError('invalid_url', 'the URL contains spaces');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SafeFetchError('invalid_url', 'the URL cannot be parsed');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SafeFetchError(
      'bad_scheme',
      `the scheme "${url.protocol.replace(':', '')}" is not allowed (https only)`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new SafeFetchError(
      'credentials_in_url',
      'the URL contains credentials; send them in a header, not in the URL',
    );
  }
  if (url.hash !== '') throw new SafeFetchError('fragment_in_url', 'the URL contains a fragment');

  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === '') throw new SafeFetchError('no_host', 'the URL has no host');
  if (host.endsWith('.')) host = host.replace(/\.$/, '');
  if (host === '' || host.endsWith('.'))
    throw new SafeFetchError('invalid_url', 'the host name is malformed');

  const isV6 = parseIPv6(host) !== null;
  const isV4 = parseIPv4(host) !== null;
  const ip = isV4 || isV6 ? host : null;
  if (!ip && /^[0-9.]+$/.test(host)) {
    // looks numeric but is not a valid dotted quad: some resolvers would still read it as an address
    throw new SafeFetchError(
      'blocked_address',
      'the host looks like a numeric IP address that is not valid',
    );
  }

  const dev = policy.allowInsecureLocalhost === true;
  let devLoopback = false;
  if (ip) {
    const c = classifyAddress(ip);
    if (!c.allowed) {
      if (dev && c.loopback) devLoopback = true;
      else
        throw new SafeFetchError(
          'blocked_address',
          `the address ${ip} is not allowed (${c.category})`,
        );
    }
  } else {
    const blockedName =
      BLOCKED_NAMES.has(host) ||
      BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) ||
      !host.includes('.');
    if (blockedName) {
      if (dev && isLocalhostName(host)) devLoopback = true;
      else
        throw new SafeFetchError(
          'blocked_name',
          `the host name "${host.slice(0, 80)}" is an internal name`,
        );
    }
  }
  if (url.protocol === 'http:' && !devLoopback) {
    throw new SafeFetchError('insecure_http', 'plain http is not allowed (https only)');
  }
  if (policy.hostDenylist?.(host))
    throw new SafeFetchError('host_denied', `the host "${host.slice(0, 80)}" is on the deny list`);
  if (policy.hostAllowlist && !policy.hostAllowlist(host)) {
    throw new SafeFetchError(
      'host_not_allowed',
      `the host "${host.slice(0, 80)}" is not on the allow list`,
    );
  }
  return { url, hostname: host, ip, devLoopback };
}

/** Same as validateUrl; the name used for the configured base URL of a provider. */
export const validateBaseUrl = validateUrl;
