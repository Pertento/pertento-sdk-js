import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { hmacSha256 } from './hmac';

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

describe('hmacSha256', () => {
  test('matches RFC 4231 test case 2', async () => {
    const digest = await hmacSha256('Jefe', 'what do ya want for nothing?');
    expect(toHex(digest)).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  test('returns 32 bytes', async () => {
    expect((await hmacSha256('salt', '')).length).toBe(32);
  });

  // Web Crypto refuses a zero-length HMAC key, which is why SPEC.md requires a non-empty salt.
  test('rejects an empty key', async () => {
    await expect(hmacSha256('', 'message')).rejects.toThrow();
  });

  // An independent implementation over UTF-8 keys and messages, including multi-byte
  // characters, so the spec's "UTF-8 bytes of the string" is what Web Crypto actually got.
  test('agrees with node:crypto on UTF-8 keys and messages', async () => {
    const cases: Array<[string, string]> = [
      ['3f8a0c1d9e7b6a5f4e3d2c1b0a998877', '42:abc'],
      ['salt-ÅÄÖ', '7:kund-åäö'],
      ['🔑', 'id:顧客-123'],
      ['k', ''],
    ];
    for (const [key, message] of cases) {
      const expected = createHmac('sha256', Buffer.from(key, 'utf8'))
        .update(Buffer.from(message, 'utf8'))
        .digest('hex');
      expect(toHex(await hmacSha256(key, message))).toBe(expected);
    }
  });
});
