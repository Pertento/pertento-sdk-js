import { afterEach, describe, expect, test } from 'bun:test';
import { createVisitorId, isUuid } from './uuid';

const V4_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const realCrypto = globalThis.crypto;

const swapCrypto = (value: unknown): void => {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
};

afterEach(() => swapCrypto(realCrypto));

describe('isUuid', () => {
  test('accepts any-case hyphenated UUIDs only', () => {
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(isUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe(true);
    expect(isUuid('3f2504e04f8941d39a0c0305e82c3301')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

describe('createVisitorId', () => {
  test('returns a lowercase v4 UUID, different each time', () => {
    const first = createVisitorId();
    expect(first).toMatch(V4_UUID);
    expect(createVisitorId()).not.toBe(first);
  });

  test('falls back to getRandomValues when randomUUID is missing or returns garbage', () => {
    swapCrypto({ getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    expect(createVisitorId()).toMatch(V4_UUID);
    swapCrypto({ randomUUID: () => 'not-a-uuid', getRandomValues: realCrypto.getRandomValues.bind(realCrypto) });
    expect(createVisitorId()).toMatch(V4_UUID);
  });

  test('throws when there is no Web Crypto random source', () => {
    swapCrypto(undefined);
    expect(() => createVisitorId()).toThrow();
  });
});
