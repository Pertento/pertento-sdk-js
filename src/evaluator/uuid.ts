const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value);

/** 16 bytes as a lowercase hyphenated UUID string. */
export function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A new random (version 4) visitor ID, created the same way the Pertento browser snippet
 * creates its visitor IDs.
 *
 * crypto.randomUUID exists only in secure contexts, so getRandomValues is the fallback.
 * Math.random is never used: its collisions across millions of visitors would merge
 * unrelated people. Throws only where neither exists, which no supported runtime is.
 */
export function createVisitorId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') {
    // Validated, not trusted: a page polyfill returning anything else falls through.
    const id: unknown = cryptoApi.randomUUID();
    if (isUuid(id)) return id.toLowerCase();
  }
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('@pertentoai/sdk: no Web Crypto random source to create a visitor ID');
  }

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  return formatUuid(bytes);
}
