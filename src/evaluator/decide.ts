import type {
  BucketOn,
  DecideIdentity,
  DecideInput,
  Decision,
  DecisionReason,
  EnrolledDecision,
  NotEnrolledDecision,
  SdkConfig,
  SdkExperiment,
  SdkVariant,
} from './types';
import { bucketFor } from './bucket';
import { EXPERIMENT_BUCKET_ON } from './constants';
import { deriveEnrolmentId } from './enrolment-id';
import { matchAttributeRules } from './targeting';
import { isObject, pickByBucket, sortById } from './weights';

type DecideExperimentParams = DecideIdentity & { experiment: Readonly<SdkExperiment>; salt: string };

/**
 * The variant one flag key resolves to for one person. Never throws on bad data, a
 * malformed config included (entries that are not objects are skipped); the only
 * rejection is Web Crypto itself failing. Checks run in a fixed order, and the first
 * that fails is the reason (spec/SPEC.md, "Decisions"):
 *
 * 1. no experiment has the key                   → 'unknown-key', everything null
 * 2. the experiment is not Running               → 'not-running'; only Deployed returns the deployed variant
 * 3. bucketOn is not a value this evaluator knows → 'wrong-id-kind', control
 * 4. no ID at all                                 → 'no-id', control
 * 5. only the other kind of ID than bucketOn      → 'wrong-id-kind', control
 * 6. the attribute rules do not match             → 'targeting', control
 * 7. otherwise                                    → enrolled in the variant the bucket falls in
 */
export async function decide({ config, salt, key, ...identity }: DecideInput): Promise<Decision> {
  const experiment = findExperiment(config, key);
  if (!experiment) {
    return {
      experimentId: null,
      variantId: null,
      variantKey: null,
      payload: null,
      enrolled: false,
      reason: 'unknown-key',
    };
  }
  return decideExperiment({ experiment, salt, ...identity });
}

export type DecideAllParams = DecideIdentity & { config: Readonly<SdkConfig>; salt: string };

/**
 * `decide` for every experiment in the config, keyed by flag key. The result has a null
 * prototype, so a lookup of a key no experiment has (`toString`, `__proto__`) is
 * `undefined`, never something inherited from Object.prototype.
 */
export async function decideAll({ config, salt, ...identity }: DecideAllParams): Promise<Record<string, Decision>> {
  const experiments = uniqueExperiments(config);
  const decisions = await Promise.all(
    experiments.map((experiment) => decideExperiment({ experiment, salt, ...identity })),
  );
  const byKey: Record<string, Decision> = Object.create(null);
  experiments.forEach((experiment, index) => {
    byKey[experiment.key] = decisions[index]!;
  });
  return byKey;
}

export type VariantMapForParams = DecideAllParams;

/** `{ [experimentId]: variantId }`, both as decimal integer strings. */
export type VariantMap = Record<string, string>;

/**
 * The experiment-variant map a server-reported conversion is attributed with:
 * `{ [experimentId]: String(variantId) }` for every Running experiment this person is
 * enrolled in, i.e. whose bucketOn matches an ID given and whose rules match. Keys and
 * values are decimal integer strings, the shape `/events` stores and the stats SQL
 * casts to bigint. Deployed and not-enrolled experiments are left out.
 */
export async function variantMapFor(params: VariantMapForParams): Promise<VariantMap> {
  const decisions = Object.values(await decideAll(params));
  const map: VariantMap = {};
  for (const decision of decisions) {
    if (!decision.enrolled) continue;
    if (!Number.isSafeInteger(decision.experimentId) || !Number.isSafeInteger(decision.variantId)) continue;
    map[String(decision.experimentId)] = String(decision.variantId);
  }
  return map;
}

async function decideExperiment({ experiment, salt, ...identity }: DecideExperimentParams): Promise<Decision> {
  const { visitorId, id, attributes } = identity;
  const variants = sortById(Array.isArray(experiment.variants) ? experiment.variants : []);
  const control = variants[0] ?? null;

  if (experiment.status !== 'Running') {
    // Only Deployed has a deployed variant; any other status (the writer emits none today) is control.
    const deployed =
      experiment.status === 'Deployed'
        ? (variants.find((variant) => variant.id === experiment.deployedVariantId) ?? control)
        : control;
    return notEnrolled({ experiment, variant: deployed, reason: 'not-running' });
  }

  // A bucketOn this evaluator does not know names an ID it cannot be given, so nobody is
  // enrolled rather than guessing at 'visitor' (spec/SPEC.md, "Decisions").
  if (!isBucketOn(experiment.bucketOn)) {
    return notEnrolled({ experiment, variant: control, reason: 'wrong-id-kind' });
  }

  const hashId = experiment.bucketOn === 'customer_id' ? presentId(id) : presentId(visitorId);
  if (hashId === undefined) {
    const otherKindGiven = presentId(id) !== undefined || presentId(visitorId) !== undefined;
    return notEnrolled({ experiment, variant: control, reason: otherKindGiven ? 'wrong-id-kind' : 'no-id' });
  }

  if (!matchAttributeRules(experiment.targeting ?? [], attributes)) {
    return notEnrolled({ experiment, variant: control, reason: 'targeting' });
  }

  // A customer ID is opaque and case-sensitive: it is turned into its enrolment UUID first,
  // and that UUID is what is bucketed. One customer ID, one enrolment ID, one bucket.
  const enrolAs =
    experiment.bucketOn === 'customer_id' ? await deriveEnrolmentId({ salt, customerId: hashId }) : undefined;
  const bucket = await bucketFor({ salt, experimentId: experiment.id, id: enrolAs ?? hashId });
  const variant = pickByBucket(variants, bucket);
  // No variant carries weight (or there are none): the experiment admits nobody. The API
  // refuses to start an experiment whose weights do not sum to 10000, so this needs
  // hand-edited data; to the caller it is the same as not running.
  if (!variant) return notEnrolled({ experiment, variant: control, reason: 'not-running' });

  const decision: EnrolledDecision = {
    experimentId: experiment.id,
    variantId: variant.id,
    variantKey: variant.key,
    payload: variant.payload,
    enrolled: true,
  };
  return enrolAs === undefined ? decision : { ...decision, enrolAs };
}

type NotEnrolledParams = { experiment: Readonly<SdkExperiment>; variant: SdkVariant | null; reason: DecisionReason };

const notEnrolled = ({ experiment, variant, reason }: NotEnrolledParams): NotEnrolledDecision => ({
  experimentId: experiment.id,
  variantId: variant?.id ?? null,
  variantKey: variant?.key ?? null,
  payload: variant ? variant.payload : null,
  enrolled: false,
  reason,
});

/** An ID counts only as a non-empty string. */
const presentId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const isBucketOn = (value: unknown): value is BucketOn =>
  typeof value === 'string' && (EXPERIMENT_BUCKET_ON as readonly string[]).includes(value);

/** The config's experiments, skipping any entry that is not an object. */
const experimentsOf = (config: Readonly<SdkConfig>): SdkExperiment[] =>
  Array.isArray(config?.experiments) ? config.experiments.filter(isObject) : [];

/** The first experiment carrying the key wins; the writer guarantees keys are unique. */
const findExperiment = (config: Readonly<SdkConfig>, key: string): SdkExperiment | undefined =>
  experimentsOf(config).find((experiment) => experiment.key === key);

function uniqueExperiments(config: Readonly<SdkConfig>): SdkExperiment[] {
  const seen = new Set<string>();
  return experimentsOf(config).filter((experiment) => {
    if (seen.has(experiment.key)) return false;
    seen.add(experiment.key);
    return true;
  });
}
