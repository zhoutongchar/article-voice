import { sha256 } from '@noble/hashes/sha2.js';

// Content scripts also run on HTTP pages, where SubtleCrypto/randomUUID are
// unavailable. getRandomValues and the bundled SHA-256 implementation work there.
export function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function digest(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = crypto.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : sha256(bytes);
  return [...hash].map(x => x.toString(16).padStart(2, '0')).join('');
}
