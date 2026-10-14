import type { SdkVariant } from './types';
import { describe, expect, test } from 'bun:test';
import { pickByBucket, sortById } from './weights';

const variant = (id: number, weight: number): SdkVariant => ({ id, key: `v${id}`, weight, payload: null });

describe('pickByBucket', () => {
  test('walks basis points in id order, whatever order the variants arrive in', () => {
    const variants = [variant(3, 2000), variant(1, 5000), variant(2, 3000)];
    expect(pickByBucket(variants, 0)?.id).toBe(1);
    expect(pickByBucket(variants, 4999)?.id).toBe(1);
    expect(pickByBucket(variants, 5000)?.id).toBe(2);
    expect(pickByBucket(variants, 7999)?.id).toBe(2);
    expect(pickByBucket(variants, 8000)?.id).toBe(3);
    expect(pickByBucket(variants, 9999)?.id).toBe(3);
  });

  test('skips zero-weight variants', () => {
    const variants = [variant(1, 0), variant(2, 10000)];
    expect(pickByBucket(variants, 0)?.id).toBe(2);
  });

  test('scales a total other than 10000 proportionally', () => {
    // total 100: point = floor(bucket * 100 / 10000)
    const variants = [variant(1, 50), variant(2, 50)];
    expect(pickByBucket(variants, 4999)?.id).toBe(1);
    expect(pickByBucket(variants, 5000)?.id).toBe(2);
    expect(pickByBucket(variants, 9999)?.id).toBe(2);
  });

  test('treats negative, fractional and non-numeric weights as the spec says', () => {
    const variants = [variant(1, -500), variant(2, 4999.9), { ...variant(3, 0), weight: 'x' as unknown as number }];
    expect(pickByBucket(variants, 0)?.id).toBe(2);
    expect(pickByBucket(variants, 9999)?.id).toBe(2);
  });

  test('a total above 10000 is scaled down, not taken modulo', () => {
    // total 15000: bucket 4000 → point 6000 → variant 2 (a modulo port would land on 1)
    const variants = [variant(1, 6000), variant(2, 9000)];
    expect(pickByBucket(variants, 3999)?.id).toBe(1);
    expect(pickByBucket(variants, 4000)?.id).toBe(2);
    expect(pickByBucket(variants, 9999)?.id).toBe(2);
  });

  test('skips entries that are not objects', () => {
    const variants = [null, variant(2, 10000), 'x'] as unknown as SdkVariant[];
    expect(pickByBucket(variants, 0)?.id).toBe(2);
  });

  test('null when nothing carries weight or there are no variants', () => {
    expect(pickByBucket([variant(1, 0), variant(2, 0)], 10)).toBeNull();
    expect(pickByBucket([], 10)).toBeNull();
  });
});

describe('sortById', () => {
  test('sorts by id ascending without touching the input', () => {
    const variants = [variant(3, 1), variant(1, 1), variant(2, 1)];
    expect(sortById(variants).map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(variants.map(({ id }) => id)).toEqual([3, 1, 2]);
  });

  test('equal ids keep their config order', () => {
    const variants = [
      variant(5, 1),
      { ...variant(1, 1), key: 'first' },
      variant(0, 1),
      { ...variant(1, 1), key: 'second' },
    ];
    expect(sortById(variants).map(({ id, key }) => `${id}:${key}`)).toEqual(['0:v0', '1:first', '1:second', '5:v5']);
  });

  test('drops entries that are not objects, and a non-array is empty', () => {
    const variants = [null, 1, 'x', [], variant(2, 1), undefined, variant(1, 1)] as unknown as SdkVariant[];
    expect(sortById(variants).map(({ id }) => id)).toEqual([1, 2]);
    expect(sortById(null as unknown as SdkVariant[])).toEqual([]);
  });
});
