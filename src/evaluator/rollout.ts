import type { AttributeRule, Attributes, SdkVariant } from './types';
import { BUCKET_COUNT } from './constants';
import { matchAttributeRules } from './targeting';
import { isObject } from './weights';

/** `rollout` absent or null is an ordinary experiment; anything else makes it a feature flag. */
export const hasRollout = (experiment: { readonly rollout?: unknown }): boolean =>
  experiment.rollout !== undefined && experiment.rollout !== null;

/**
 * A flag's rollout, checked once per decision. `valid: false` is a rollout the evaluator cannot
 * act on (it names no variant, the experiment is not exactly an Off/On pair, or its rings are not
 * a list): the flag then behaves as not running, serving `off`.
 */
export type ResolvedRollout =
  | { valid: true; on: SdkVariant; off: SdkVariant; limit: number; rings: readonly unknown[] }
  | { valid: false; off: SdkVariant | null };

type ResolveRolloutParams = { rollout: unknown; variants: readonly SdkVariant[] };

/**
 * Off is the lowest-id variant that is not `onVariantId`: the control when the pair is well
 * formed, and still a sensible answer when it is not. `variants` is already sorted by id.
 */
export function resolveRollout({ rollout, variants }: ResolveRolloutParams): ResolvedRollout {
  const onVariantId = isObject(rollout) ? rollout['onVariantId'] : undefined;
  const off = variants.find((variant) => variant.id !== onVariantId) ?? null;
  if (!isObject(rollout) || variants.length !== 2 || !off) return { valid: false, off };

  const on = variants.find((variant) => variant.id === onVariantId);
  if (!on) return { valid: false, off };

  const rings = rollout['rings'] ?? [];
  if (!Array.isArray(rings)) return { valid: false, off };

  return { valid: true, on, off, limit: rolloutLimit(rollout['rolloutBp'], rollout['holdbackBp']), rings };
}

/** A basis-point value as the spec reads it: a finite number floored and clamped to 0..10000; anything else is 0. */
export const clampBasisPoints = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(BUCKET_COUNT, Math.max(0, Math.floor(value))) : 0;

/**
 * Buckets below the limit are On. The holdback takes the top of the range, so raising the
 * rollout only ever adds buckets below it and nobody in the holdback is ever On.
 */
export const rolloutLimit = (rolloutBp: unknown, holdbackBp: unknown): number =>
  Math.min(clampBasisPoints(rolloutBp), BUCKET_COUNT - clampBasisPoints(holdbackBp));

type MatchRingParams = {
  rings: readonly unknown[];
  attributes: Attributes | undefined;
  /** The ID `bucketOn` names, raw: the visitor ID, or the customer's own ID. */
  id: string;
  /** Visitor IDs are UUIDs and compare case-insensitively; customer IDs are opaque and exact. */
  caseInsensitive: boolean;
};

/**
 * The side the first matching ring serves, or null when none matches. A ring that is not an
 * object, or whose `serve` is neither 'on' nor 'off', never matches; its rules follow
 * matchAttributeRules (null or absent is an empty list, which matches everyone); `ids` that is
 * set but not a list never matches.
 */
export function matchRing({ rings, attributes, id, caseInsensitive }: MatchRingParams): 'on' | 'off' | null {
  const wanted = caseInsensitive ? id.toLowerCase() : id;
  for (const ring of rings) {
    if (!isObject(ring)) continue;
    const serve = ring['serve'];
    if (serve !== 'on' && serve !== 'off') continue;
    if (!matchAttributeRules((ring['rules'] ?? []) as readonly AttributeRule[], attributes)) continue;
    if (!idListed({ ids: ring['ids'], wanted, caseInsensitive })) continue;
    return serve;
  }
  return null;
}

type IdListedParams = { ids: unknown; wanted: string; caseInsensitive: boolean };

/** No `ids` (absent or null) puts no condition on the ID; otherwise it must be a list holding it. */
function idListed({ ids, wanted, caseInsensitive }: IdListedParams): boolean {
  if (ids === undefined || ids === null) return true;
  if (!Array.isArray(ids)) return false;
  return ids.some(
    (listed: unknown) => typeof listed === 'string' && (caseInsensitive ? listed.toLowerCase() : listed) === wanted,
  );
}
