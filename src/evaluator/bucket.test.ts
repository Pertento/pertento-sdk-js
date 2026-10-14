import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { bucketFor } from './bucket';
import { pickByBucket } from './weights';
import { createVisitorId } from './uuid';

const SALT = '9c1f0e6b2a7d4c3e8f5a1b0d2c4e6f8a9c1f0e6b2a7d4c3e8f5a1b0d2c4e6f8a';

/** The spec's formula written out independently with node:crypto. */
function referenceBucket(salt: string, experimentId: number, id: string): number {
  const digest = createHmac('sha256', Buffer.from(salt, 'utf8'))
    .update(Buffer.from(`${experimentId}:${id.toLowerCase()}`, 'utf8'))
    .digest();
  return digest.readUInt32BE(0) % 10000;
}

describe('bucketFor', () => {
  test('matches the spec formula computed independently', async () => {
    const ids = ['3F2504E0-4F89-41D3-9A0C-0305E82C3301', 'customer-42', 'Kund-ÅÄÖ', '顧客-7', ''];
    for (const id of ids) {
      expect(await bucketFor({ salt: SALT, experimentId: 1234, id })).toBe(referenceBucket(SALT, 1234, id));
    }
  });

  test('is in [0, 10000) and deterministic', async () => {
    const first = await bucketFor({ salt: SALT, experimentId: 1, id: 'abc' });
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(10000);
    expect(await bucketFor({ salt: SALT, experimentId: 1, id: 'abc' })).toBe(first);
  });

  test('ignores the casing of the ID', async () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(await bucketFor({ salt: SALT, experimentId: 9, id: id.toUpperCase() })).toBe(
      await bucketFor({ salt: SALT, experimentId: 9, id }),
    );
  });

  test('depends on the experiment and the salt', async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `visitor-${index}`);
    const inOne = await Promise.all(ids.map((id) => bucketFor({ salt: SALT, experimentId: 1, id })));
    const inTwo = await Promise.all(ids.map((id) => bucketFor({ salt: SALT, experimentId: 2, id })));
    const otherSalt = await Promise.all(ids.map((id) => bucketFor({ salt: 'other', experimentId: 1, id })));
    expect(inOne).not.toEqual(inTwo);
    expect(inOne).not.toEqual(otherSalt);
  });

  // 100k random visitor IDs split 70/30. The standard deviation of a 70% share over
  // 100k draws is sqrt(0.7 * 0.3 / 100000) ≈ 0.145%, so ±0.5% is about 3.4 sigma.
  // Modulo bias is negligible: 2^32 % 10000 = 7296 values out of 2^32.
  test('splits 100k visitors 70/30 within ±0.5%', async () => {
    const variants = [
      { id: 10, key: 'control', weight: 7000, payload: null },
      { id: 11, key: 'treatment', weight: 3000, payload: null },
    ];
    const count = 100_000;
    const buckets = await Promise.all(
      Array.from({ length: count }, () => bucketFor({ salt: SALT, experimentId: 77, id: createVisitorId() })),
    );
    const control = buckets.filter((bucket) => pickByBucket(variants, bucket)?.id === 10).length;
    expect(Math.abs(control / count - 0.7)).toBeLessThan(0.005);
  });
});
