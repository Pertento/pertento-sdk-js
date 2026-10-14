import type { SdkVariant } from './types';
import { describe, expect, test } from 'bun:test';
import { pickByBucket } from './weights';

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

  test('null when nothing carries weight or there are no variants', () => {
    expect(pickByBucket([variant(1, 0), variant(2, 0)], 10)).toBeNull();
    expect(pickByBucket([], 10)).toBeNull();
  });
});
