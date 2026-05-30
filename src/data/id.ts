// ULID-style ID generator. 26-char base32, time-sortable.
// Self-rolled to avoid adding a dependency for a 30-line module.
//
// Format: <10 chars time><16 chars random> = 26 chars total
//   time: 48-bit ms timestamp, Crockford base32
//   random: 80-bit random (10 bytes), Crockford base32
//
// Collision probability: ~negligible for the per-vault scale modular targets.

import type { EntityId } from './types';

// Crockford base32 alphabet (omits I, L, O, U for visual clarity).
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    const mod = ms % 32;
    out = ALPHABET[mod] + out;
    ms = (ms - mod) / 32;
  }
  return out;
}

function encodeRandom(len: number): string {
  // 5 bits per char → ceil(len*5/8) bytes needed.
  const bytes = new Uint8Array(Math.ceil((len * 5) / 8));
  crypto.getRandomValues(bytes);
  let out = '';
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIdx = 0;
  while (out.length < len) {
    if (bitCount < 5 && byteIdx < bytes.length) {
      bitBuffer = (bitBuffer << 8) | bytes[byteIdx++];
      bitCount += 8;
    }
    const shift = bitCount - 5;
    const idx = (bitBuffer >> shift) & 0x1f;
    bitBuffer = bitBuffer & ((1 << shift) - 1);
    bitCount -= 5;
    out += ALPHABET[idx];
  }
  return out;
}

export function newId(): EntityId {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidId(s: unknown): s is EntityId {
  return typeof s === 'string' && ID_RE.test(s);
}
