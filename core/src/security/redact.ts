/**
 * Redaction for every logger, error and trace path. Two layers: exact secrets the caller knows
 * (the configured API key) and patterns that look like credentials (bearer tokens, common key
 * prefixes, URL credentials, key=value pairs).
 */
const MASK = '[REDACTED]';

const PATTERNS: [RegExp, string][] = [
  [/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;"']+/gi, `$1$2${MASK}`],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
  [/\b(?:sk|gsk|pk|rk|xai|hf|r8|tgp)[-_][A-Za-z0-9_-]{12,}/g, MASK],
  [
    /((?:api[-_]?key|apikey|x-api-key|access[-_]?token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    `$1${MASK}`,
  ],
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
];

/** Replaces the given secrets and anything that looks like a credential. */
export function redactText(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join(MASK);
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

const SENSITIVE_KEY =
  /authorization|api[-_]?key|apikey|secret|token|password|passwd|credential|cookie/i;

/** Deep copy with sensitive keys masked and every string value redacted. Safe for logs and traces. */
export function redactDeep<T>(value: T, secrets: readonly (string | undefined)[] = []): T {
  const seen = new WeakSet<object>();
  const walk = (v: unknown, key?: string): unknown => {
    if (key && SENSITIVE_KEY.test(key) && typeof v === 'string') return MASK;
    if (typeof v === 'string') return redactText(v, secrets);
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => walk(x));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
  };
  return walk(value) as T;
}

/** What a user interface may show of a key: only the last 4 characters. */
export function maskKey(key: string | undefined): string {
  if (!key) return '(none)';
  return key.length <= 8 ? '••••' : `••••${key.slice(-4)}`;
}
