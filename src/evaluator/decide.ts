import type {
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
import { deriveEnrolmentId } from './enrolment-id';
import { matchAttributeRules } from './targeting';
import { pickByBucket, sortById } from './weights';

type DecideExperimentParams = DecideIdentity & { experiment: Readonly<SdkExperiment>; salt: string };

/**
 * The variant one flag key resolves to for one person. Never throws on bad data; the
 * only rejection is Web Crypto itself failing. Checks run in a fixed order, and the
 * first that fails is the reason (spec/SPEC.md, "Decisions"):
 *
 * 1. no experiment has the key                   → 'unknown-key', everything null
 * 2. the experiment is not Running               → 'not-running'; Deployed returns the deployed variant
 * 3. no ID at all                                 → 'no-id', control
 * 4. only the other kind of ID than bucketOn      → 'wrong-id-kind', control
 * 5. the attribute rules do not match             → 'targeting', control
 * 6. otherwise                                    → enrolled in the variant the bucket falls in
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

/** `decide` for every experiment in the config, keyed by flag key. */
export async function decideAll({ config, salt, ...identity }: DecideAllParams): Promise<Record<string, Decision>> {
  const experiments = uniqueExperiments(config);
  const decisions = await Promise.all(
    experiments.map((experiment) => decideExperiment({ experiment, salt, ...identity })),
  );
  return Object.fromEntries(experiments.map((experiment, index) => [experiment.key, decisions[index]!]));
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
    const deployed = variants.find((variant) => variant.id === experiment.deployedVariantId) ?? control;
    return notEnrolled({ experiment, variant: deployed, reason: 'not-running' });
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

const experimentsOf = (config: Readonly<SdkConfig>): SdkExperiment[] =>
  Array.isArray(config?.experiments) ? config.experiments : [];

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
