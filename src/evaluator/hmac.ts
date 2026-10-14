const encoder = new TextEncoder();

/**
 * HMAC-SHA256 over UTF-8 strings: the key is the UTF-8 bytes of `key` exactly as given
 * (a hex salt is NOT hex-decoded), the message the UTF-8 bytes of `message`.
 *
 * Async because Web Crypto is the only primitive that exists unchanged in browsers,
 * Node 20+, Bun, Deno and edge workers, and it has no synchronous HMAC.
 */
export async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return new Uint8Array(signature);
}
