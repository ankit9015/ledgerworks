/**
 * IP address parsing and classification for SSRF defence. IPv4 is allowed unless it is in a
 * special-purpose range; IPv6 is allowed only inside global unicast 2000::/3 and outside the
 * special-purpose ranges inside it (an allowlist: everything else is refused).
 */

export function parseIPv4(s: string): bigint | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let v = 0n;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n > 255 || (m[i]!.length > 1 && m[i]!.startsWith('0'))) return null; // no leading zeros: "0177.0.0.1" is not an address here
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

/** Full IPv6 parser: "::" compression and an embedded dotted IPv4 tail. A zone id ("%eth0") is not accepted. */
export function parseIPv6(input: string): bigint | null {
  let s = input;
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (s.includes('%') || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let tail: bigint[] = [];
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [(v4 >> 16n) & 0xffffn, v4 & 0xffffn];
    s = s.slice(0, lastColon + 1) + '0:0';
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groups(dbl[0]!);
  const rest = dbl.length === 2 ? groups(dbl[1]!) : [];
  const total = head.length + rest.length;
  if (dbl.length === 1 ? total !== 8 : total > 7) return null;
  const fill = dbl.length === 2 ? new Array<string>(8 - total).fill('0') : [];
  const all = [...head, ...fill, ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const nums = all.map((g) => BigInt(parseInt(g, 16)));
  if (tail.length) {
    nums[6] = tail[0]!;
    nums[7] = tail[1]!;
  }
  return nums.reduce((acc, n) => (acc << 16n) | n, 0n);
}

interface Range {
  base: bigint;
  bits: number;
  label: string;
}
const v4 = (cidr: string, label: string): Range => {
  const [a, b] = cidr.split('/');
  return { base: parseIPv4(a!)!, bits: Number(b), label };
};
const v6 = (cidr: string, label: string): Range => {
  const [a, b] = cidr.split('/');
  return { base: parseIPv6(a!)!, bits: Number(b), label };
};

const V4_BLOCKED: Range[] = [
  v4('0.0.0.0/8', 'unspecified / "this network"'),
  v4('10.0.0.0/8', 'private (RFC 1918)'),
  v4('100.64.0.0/10', 'carrier-grade NAT'),
  v4('127.0.0.0/8', 'loopback'),
  v4('169.254.0.0/16', 'link-local (includes cloud metadata 169.254.169.254)'),
  v4('172.16.0.0/12', 'private (RFC 1918)'),
  v4('192.0.0.0/24', 'IETF protocol assignments'),
  v4('192.0.2.0/24', 'documentation'),
  v4('192.88.99.0/24', '6to4 relay anycast'),
  v4('192.168.0.0/16', 'private (RFC 1918)'),
  v4('198.18.0.0/15', 'benchmarking'),
  v4('198.51.100.0/24', 'documentation'),
  v4('203.0.113.0/24', 'documentation'),
  v4('224.0.0.0/4', 'multicast'),
  v4('240.0.0.0/4', 'reserved (includes the broadcast address)'),
];

const V6_BLOCKED: Range[] = [
  v6('::/128', 'unspecified'),
  v6('::1/128', 'loopback'),
  v6('::ffff:0:0/96', 'IPv4-mapped'),
  v6('::/96', 'IPv4-compatible (deprecated)'),
  v6('64:ff9b::/96', 'NAT64'),
  v6('64:ff9b:1::/48', 'NAT64 (local use)'),
  v6('100::/64', 'discard-only'),
  v6('2001::/32', 'Teredo'),
  v6('2001:10::/28', 'ORCHID'),
  v6('2001:20::/28', 'ORCHIDv2'),
  v6('2001:db8::/32', 'documentation'),
  v6('2002::/16', '6to4 (embeds an IPv4 address)'),
  v6('fc00::/7', 'unique local'),
  v6('fe80::/10', 'link-local'),
  v6('fec0::/10', 'site-local (deprecated)'),
  v6('ff00::/8', 'multicast'),
];
const V6_GLOBAL = v6('2000::/3', 'global unicast');

const inRange = (value: bigint, r: Range, width: 32 | 128): boolean => {
  const shift = BigInt(width - r.bits);
  return value >> shift === r.base >> shift;
};

export interface AddressClass {
  allowed: boolean;
  version: 4 | 6 | null;
  /** why it is refused, or "public" */
  category: string;
  loopback: boolean;
}

/** Classifies an IPv4 or IPv6 literal. An unparsable string is refused. */
export function classifyAddress(ip: string): AddressClass {
  const a4 = parseIPv4(ip);
  if (a4 !== null) {
    for (const r of V4_BLOCKED) {
      if (inRange(a4, r, 32))
        return { allowed: false, version: 4, category: r.label, loopback: r.label === 'loopback' };
    }
    return { allowed: true, version: 4, category: 'public', loopback: false };
  }
  const a6 = parseIPv6(ip);
  if (a6 !== null) {
    for (const r of V6_BLOCKED) {
      if (inRange(a6, r, 128))
        return { allowed: false, version: 6, category: r.label, loopback: r.label === 'loopback' };
    }
    if (!inRange(a6, V6_GLOBAL, 128))
      return {
        allowed: false,
        version: 6,
        category: 'outside global unicast 2000::/3',
        loopback: false,
      };
    return { allowed: true, version: 6, category: 'public', loopback: false };
  }
  return { allowed: false, version: null, category: 'not an IP address', loopback: false };
}
