/**
 * AES-256-GCM column encryption for storing sensitive data (e.g. target API tokens).
 *
 * Storage format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
 * Key: ENCRYPTION_KEY env var (64 hex chars = 32 bytes), used directly (no KDF).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;       // GCM recommended 96-bit IV
const AUTH_TAG_LENGTH = 16; // GCM auth tag size in bytes

// Parse the 32-byte key from hex once at module load.
const KEY = Buffer.from(env.ENCRYPTION_KEY, 'hex');

/**
 * Encrypt a plaintext string.
 * @returns `<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, KEY, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  // getAuthTag() MUST be called after cipher.final()
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a ciphertext string produced by `encrypt()`.
 * Throws if the ciphertext is malformed or tampered.
 */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format: expected <iv_hex>:<authTag_hex>:<ciphertext_hex>');
  }
  const [ivHex, authTagHex, ctHex] = parts as [string, string, string];

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');

  const decipher = createDecipheriv(ALGORITHM, KEY, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ct),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
