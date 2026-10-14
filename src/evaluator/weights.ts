import type { SdkVariant } from './types';
import { BUCKET_COUNT } from './constants';

/** A weight that is not a finite positive number counts as 0; fractions are floored. */
export const normaliseWeight = (weight: unknown): number =>
  typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? Math.floor(weight) : 0;

/** A non-null, non-array object: what a config entry must be to be read at all. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A copy sorted by id ascending: control (the lowest id) first. Entries that are not
 * objects are dropped. Equal ids keep their config order: the tie-break on the original
 * index makes that explicit rather than relying on the engine's sort being stable.
 */
export function sortById(variants: readonly SdkVariant[]): SdkVariant[] {
  if (!Array.isArray(variants)) return [];
  return variants
    .map((variant, index) => ({ variant, index }))
    .filter((entry): entry is { variant: SdkVariant; index: number } => isObject(entry.variant))
    .sort((a, b) => a.variant.id - b.variant.id || a.index - b.index)
    .map(({ variant }) => variant);
}

/**
 * The variant a bucket falls in: a cumulative walk over the weights in id order.
 *
 * The bucket is scaled to the actual weight total first, floor(bucket * total / 10000),
 * so a stored distribution that does not sum to 10000 still splits proportionally
 * (the browser runtime's pickRandomVariant normalises the same way). With the usual
 * total of 10000 the scaled point is the bucket itself.
 *
 * Returns null only when no variant carries any weight.
 */
export function pickByBucket(variants: readonly SdkVariant[], bucket: number): SdkVariant | null {
  const sorted = sortById(variants);
  const total = sorted.reduce((sum, variant) => sum + normaliseWeight(variant.weight), 0);
  if (total <= 0) return null;

  let remaining = Math.floor((bucket * total) / BUCKET_COUNT);
  for (const variant of sorted) {
    const weight = normaliseWeight(variant.weight);
    if (remaining < weight) return variant;
    remaining -= weight;
  }
  return null;
}
