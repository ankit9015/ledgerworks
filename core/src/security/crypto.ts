import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption of stored provider configs (the API key inside them): AES-256-GCM, a random 96-bit
 * nonce per value, keys supplied from the environment and never stored with the data, rotation by
 * a key id in the stored value.
 *
 * Stored form:  lw1.<keyId>.<nonce>.<ciphertext>.<tag>   (the three binary parts base64url)
 */

const VERSION = 'lw1';
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export class SecretConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretConfigError';
  }
}
export class DecryptionError extends Error {
  constructor() {
    super(
      'could not decrypt the stored value (wrong key, unknown key id, or the value was changed)',
    );
    this.name = 'DecryptionError';
  }
}

export class Keyring {
  private keys: Map<string, Buffer>;
  readonly currentId: string;

  constructor(keys: Record<string, Buffer>, currentId: string) {
    this.keys = new Map(Object.entries(keys));
    if (this.keys.size === 0) throw new SecretConfigError('the keyring has no keys');
    for (const [id, k] of this.keys) {
      if (!KEY_ID.test(id))
        throw new SecretConfigError(
          `key id "${id.slice(0, 40)}" is not valid (letters, digits, - and _, up to 32)`,
        );
      if (k.length !== 32) throw new SecretConfigError(`key "${id}" is not 32 bytes (AES-256)`);
    }
    if (!this.keys.has(currentId))
      throw new SecretConfigError(
        `the current key id "${currentId.slice(0, 40)}" is not in the keyring`,
      );
    this.currentId = currentId;
  }

  /**
   * From the environment: LEDGERWORKS_SECRET_KEYS = "id1:<base64 of 32 bytes>,id2:<base64>" and
   * LEDGERWORKS_SECRET_KEY_ID = the id used for new values. The keys live only in the environment.
   */
  static fromEnv(env: NodeJS.ProcessEnv, names: { keys?: string; current?: string } = {}): Keyring {
    const keysVar = names.keys ?? 'LEDGERWORKS_SECRET_KEYS';
    const currentVar = names.current ?? 'LEDGERWORKS_SECRET_KEY_ID';
    const spec = env[keysVar];
    const current = env[currentVar];
    if (!spec) throw new SecretConfigError(`${keysVar} is not set`);
    if (!current) throw new SecretConfigError(`${currentVar} is not set`);
    const keys: Record<string, Buffer> = {};
    for (const part of spec.split(',')) {
      const i = part.indexOf(':');
      if (i <= 0)
        throw new SecretConfigError(`${keysVar} must look like "id:base64key,id2:base64key"`);
      keys[part.slice(0, i).trim()] = Buffer.from(part.slice(i + 1).trim(), 'base64');
    }
    return new Keyring(keys, current.trim());
  }

  get(id: string): Buffer | undefined {
    return this.keys.get(id);
  }
  ids(): string[] {
    return [...this.keys.keys()];
  }
}

/** A fresh random key, base64, for LEDGERWORKS_SECRET_KEYS. */
export const generateKey = (): string => randomBytes(32).toString('base64');

const b64 = (b: Buffer): string => b.toString('base64url');

/** `context` (for example the id of the config) is authenticated but not stored: a value copied to another row fails to decrypt. */
export function encryptSecret(ring: Keyring, plaintext: string, context = ''): string {
  const key = ring.get(ring.currentId)!;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`${VERSION}.${ring.currentId}.${context}`));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, ring.currentId, b64(nonce), b64(ct), b64(cipher.getAuthTag())].join('.');
}

function parse(token: string): { id: string; nonce: Buffer; ct: Buffer; tag: Buffer } {
  const p = token.split('.');
  if (p.length !== 5 || p[0] !== VERSION || !KEY_ID.test(p[1]!)) throw new DecryptionError();
  return {
    id: p[1]!,
    nonce: Buffer.from(p[2]!, 'base64url'),
    ct: Buffer.from(p[3]!, 'base64url'),
    tag: Buffer.from(p[4]!, 'base64url'),
  };
}

export function decryptSecret(ring: Keyring, token: string, context = ''): string {
  let parts;
  try {
    parts = parse(token);
  } catch {
    throw new DecryptionError();
  }
  const key = ring.get(parts.id);
  if (!key || parts.nonce.length !== 12 || parts.tag.length !== 16) throw new DecryptionError();
  try {
    const d = createDecipheriv('aes-256-gcm', key, parts.nonce);
    d.setAAD(Buffer.from(`${VERSION}.${parts.id}.${context}`));
    d.setAuthTag(parts.tag);
    return Buffer.concat([d.update(parts.ct), d.final()]).toString('utf8');
  } catch {
    throw new DecryptionError();
  }
}

/** True when the value was encrypted with a key other than the current one. */
export function needsRotation(ring: Keyring, token: string): boolean {
  try {
    return parse(token).id !== ring.currentId;
  } catch {
    return false;
  }
}

/** Decrypts with whichever key it was written with and encrypts again with the current key. */
export function reencryptSecret(ring: Keyring, token: string, context = ''): string {
  return encryptSecret(ring, decryptSecret(ring, token, context), context);
}
