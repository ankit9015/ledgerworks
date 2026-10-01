import { createHash, randomBytes } from 'node:crypto';

/** Raw key format: lk_<8 hex>_<43 base64url chars>. The first part (lk_<8 hex>) is the prefix. */
export const API_KEY_PATTERN = /^lk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/;

export interface GeneratedApiKey {
  /** Shown to the user exactly once; never stored. */
  raw: string;
  /** Non-secret, safe to display and log. */
  prefix: string;
  /** SHA-256 hex of the raw key: the only form that is stored. */
  hash: string;
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * 256 bits of randomness, so a plain SHA-256 is enough (no salt or slow hash needed: there is
 * nothing to brute-force). See DECISIONS.md.
 */
export function generateApiKey(): GeneratedApiKey {
  const prefix = `lk_${randomBytes(4).toString('hex')}`;
  const raw = `${prefix}_${randomBytes(32).toString('base64url')}`;
  return { raw, prefix, hash: hashApiKey(raw) };
}
