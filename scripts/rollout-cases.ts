/**
 * The feature-flag (rollout) half of spec/vectors.json, used by generate-vectors.ts.
 *
 * Flags get a config of their own, `rolloutConfig`, rather than joining `decisionConfig`: every
 * variant map runs against every experiment in its config, so adding flags there would change
 * vectors that have nothing to do with rollouts.
 *
 * The boundary cases need a visitor ID that lands in one exact bucket of one flag. Those are
 * found by a deterministic search over `00000000-0000-4000-8000-<n in hex>`, so regenerating
 * gives the same IDs.
 */
import type {
  DecideIdentity,
  SdkConfig,
  SdkExperiment,
  SdkRing,
  SdkRollout,
} from '../src/evaluator';
import { bucketFor, configVersionFor } from '../src/evaluator';

export type RolloutDecisionCase = { name: string; input: DecideIdentity & { key: string } };
export type RolloutVariantMapCase = { name: string; input: DecideIdentity };

type BuildRolloutCasesParams = { salt: string; visitor: string };

type RolloutCases = {
  config: SdkConfig;
  decisionCases: RolloutDecisionCase[];
  variantMapCases: RolloutVariantMapCase[];
};

const OFF_ID = 9101;
const ON_ID = 9102;

const FLAG_VARIANTS = [
  { id: OFF_ID, key: 'off', weight: 5000, payload: { enabled: false } },
  { id: ON_ID, key: 'on', weight: 5000, payload: { enabled: true } },
];

type FlagParams = { id: number; key: string; rollout: Partial<SdkRollout>; overrides?: Partial<SdkExperiment> };

const flag = ({ id, key, rollout, overrides = {} }: FlagParams): SdkExperiment => ({
  id,
  key,
  status: 'Running',
  bucketOn: 'visitor',
  variants: FLAG_VARIANTS,
  deployedVariantId: null,
  targeting: [],
  rollout: { onVariantId: ON_ID, rolloutBp: 0, holdbackBp: 0, rings: [], ...rollout },
  ...overrides,
});

/** Data a well-behaved writer never emits, typed as what the reader is handed. */
const malformed = <T>(value: unknown): T => value as T;

type FindVisitorParams = { salt: string; experimentId: number; bucket: number };

/** The first visitor ID of the search sequence whose bucket in this experiment is `bucket`. */
async function visitorInBucket({ salt, experimentId, bucket }: FindVisitorParams): Promise<string> {
  for (let n = 0; n < 2_000_000; n++) {
    const id = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
    if ((await bucketFor({ salt, experimentId, id })) === bucket) return id;
  }
  throw new Error(`No visitor ID found for bucket ${bucket} of experiment ${experimentId}`);
}

type BoundaryCaseParams = { salt: string; experiment: SdkExperiment; buckets: Array<[number, string]> };

/** One decision case per bucket, each with a visitor ID that lands exactly there. */
async function boundaryCases({ salt, experiment, buckets }: BoundaryCaseParams): Promise<RolloutDecisionCase[]> {
  const cases: RolloutDecisionCase[] = [];
  for (const [bucket, label] of buckets) {
    const visitorId = await visitorInBucket({ salt, experimentId: experiment.id, bucket });
    cases.push({ name: `${experiment.key}: bucket ${bucket} ${label}`, input: { key: experiment.key, visitorId } });
  }
  return cases;
}

const STAFF_ON: SdkRing = { rules: [{ attribute: 'staff', operator: 'equals', value: true }], serve: 'on' };

export async function buildRolloutCases({ salt, visitor }: BuildRolloutCasesParams): Promise<RolloutCases> {
  const listedVisitor = 'b7c6a1e2-0d4f-4a8b-9c3e-5f6a7b8c9d0e';
  const betaVisitor = 'c0ffee00-1234-4abc-8def-0123456789ab';
  const oddRingVisitor = '00000000-0000-4000-8000-0000000000ff';

  const quarter = flag({ id: 601, key: 'flag-quarter', rollout: { rolloutBp: 2500 } });
  const holdback = flag({ id: 602, key: 'flag-holdback', rollout: { rolloutBp: 10000, holdbackBp: 1000 } });
  const holdbackCaps = flag({
    id: 603,
    key: 'flag-holdback-caps-rollout',
    rollout: { rolloutBp: 5000, holdbackBp: 7000 },
  });
  const clampedHigh = flag({ id: 604, key: 'flag-clamped-high', rollout: { rolloutBp: 25000, holdbackBp: -50 } });
  const clampedLow = flag({ id: 605, key: 'flag-clamped-low', rollout: { rolloutBp: -1 } });
  const fractional = flag({ id: 606, key: 'flag-fractional', rollout: { rolloutBp: 2500.9, holdbackBp: 0.5 } });
  const stringBp = flag({ id: 607, key: 'flag-string-bp', rollout: { rolloutBp: malformed<number>('10000') } });
  const ringed = flag({
    id: 608,
    key: 'flag-rings',
    rollout: {
      rolloutBp: 5000,
      rings: [
        STAFF_ON,
        // Upper case on purpose: visitor IDs in a ring compare case-insensitively.
        { rules: [], ids: [listedVisitor.toUpperCase(), 'not-a-visitor'], serve: 'off' },
        { rules: [{ attribute: 'beta', operator: 'exists' }], ids: [betaVisitor], serve: 'on' },
      ],
    },
    overrides: { targeting: [{ attribute: 'plan', operator: 'in', value: ['pro', 'business'] }] },
  });
  const byCustomer = flag({
    id: 609,
    key: 'flag-customer',
    rollout: {
      rolloutBp: 5000,
      rings: [
        { rules: [], ids: ['Cust-1'], serve: 'on' },
        { rules: [], ids: ['vip-7'], serve: 'off' },
      ],
    },
    overrides: { bucketOn: 'customer_id' },
  });
  const onLowestId = flag({
    id: 610,
    key: 'flag-on-lowest-id',
    rollout: { onVariantId: 9201, rolloutBp: 10000 },
    overrides: {
      variants: [
        { id: 9202, key: 'off', weight: 5000, payload: 'off' },
        { id: 9201, key: 'on', weight: 5000, payload: 'on' },
      ],
    },
  });
  const unknownOn = flag({ id: 611, key: 'flag-unknown-on-variant', rollout: { onVariantId: 9999, rolloutBp: 10000 } });
  const threeVariants = flag({
    id: 612,
    key: 'flag-three-variants',
    rollout: { rolloutBp: 10000 },
    overrides: { variants: [...FLAG_VARIANTS, { id: 9103, key: 'extra', weight: 0, payload: null }] },
  });
  const rolloutNotObject: SdkExperiment = {
    ...flag({ id: 613, key: 'flag-rollout-not-object', rollout: {} }),
    rollout: malformed<SdkRollout>('full'),
  };
  const ringsNotList = flag({
    id: 614,
    key: 'flag-rings-not-list',
    rollout: { rolloutBp: 10000, rings: malformed<SdkRing[]>({}) },
  });
  const oddRings = flag({
    id: 615,
    key: 'flag-odd-rings',
    rollout: {
      rolloutBp: 10000,
      rings: malformed<SdkRing[]>([
        null,
        'staff',
        { rules: [], serve: 'maybe' },
        { rules: 'staff', serve: 'on' },
        { rules: [], ids: visitor, serve: 'on' },
        { rules: [], ids: [42, null], serve: 'on' },
        { ids: [oddRingVisitor], serve: 'off' },
      ]),
    },
  });
  const deployed = flag({
    id: 616,
    key: 'flag-deployed',
    rollout: { rolloutBp: 0 },
    overrides: { status: 'Deployed', deployedVariantId: ON_ID },
  });
  const nullRings = flag({
    id: 617,
    key: 'flag-null-rings',
    rollout: { rolloutBp: 10000, rings: malformed<SdkRing[]>(null) },
  });
  const rolloutNull: SdkExperiment = {
    ...flag({ id: 618, key: 'rollout-null-is-a-split', rollout: {} }),
    rollout: malformed<SdkRollout>(null),
  };

  const experiments = [
    quarter,
    holdback,
    holdbackCaps,
    clampedHigh,
    clampedLow,
    fractional,
    stringBp,
    ringed,
    byCustomer,
    onLowestId,
    unknownOn,
    threeVariants,
    rolloutNotObject,
    ringsNotList,
    oddRings,
    deployed,
    nullRings,
    rolloutNull,
  ];
  // Version 2, as the config has rollouts.
  const config: SdkConfig = {
    version: configVersionFor(experiments),
    websiteId: 77,
    generatedAt: 1_760_400_000_000,
    trackingMethod: 'server',
    experiments,
  };

  const pro = { plan: 'pro' };
  const decisionCases: RolloutDecisionCase[] = [
    ...(await boundaryCases({
      salt,
      experiment: quarter,
      buckets: [
        [0, 'is On'],
        [2499, '(limit - 1) is On'],
        [2500, '(limit) is Off'],
        [9999, 'is Off'],
      ],
    })),
    { name: 'flag-quarter: a visitor', input: { key: quarter.key, visitorId: visitor } },
    { name: 'flag-quarter: reason no-id', input: { key: quarter.key } },
    { name: 'flag-quarter: reason wrong-id-kind', input: { key: quarter.key, id: 'customer-42' } },
    ...(await boundaryCases({
      salt,
      experiment: holdback,
      buckets: [
        [8999, '(limit - 1) is On at 100%'],
        [9000, '(first held back) is Off at 100%'],
        [9999, '(held back) is Off at 100%'],
      ],
    })),
    ...(await boundaryCases({
      salt,
      experiment: holdbackCaps,
      buckets: [
        [2999, '(limit - 1) is On'],
        [3000, '(limit) is Off'],
      ],
    })),
    ...(await boundaryCases({ salt, experiment: clampedHigh, buckets: [[9999, 'is On (rollout clamped to 10000)']] })),
    ...(await boundaryCases({ salt, experiment: clampedLow, buckets: [[0, 'is Off (rollout clamped to 0)']] })),
    ...(await boundaryCases({
      salt,
      experiment: fractional,
      buckets: [
        [2499, 'is On (2500.9 floors to 2500)'],
        [2500, 'is Off (2500.9 floors to 2500)'],
      ],
    })),
    { name: 'flag-string-bp: a string rollout is 0', input: { key: stringBp.key, visitorId: visitor } },
    {
      name: 'flag-rings: eligibility comes before rings (ineligible staff is Off, targeting)',
      input: { key: ringed.key, visitorId: visitor, attributes: { plan: 'free', staff: true } },
    },
    {
      name: 'flag-rings: staff ring serves On',
      input: { key: ringed.key, visitorId: visitor, attributes: { ...pro, staff: true } },
    },
    {
      name: 'flag-rings: listed ID serves Off, matched case-insensitively',
      input: { key: ringed.key, visitorId: listedVisitor, attributes: pro },
    },
    {
      name: 'flag-rings: the first matching ring wins (listed staff is On)',
      input: { key: ringed.key, visitorId: listedVisitor, attributes: { ...pro, staff: true } },
    },
    {
      name: 'flag-rings: a ring with rules and ids matches when both do',
      input: { key: ringed.key, visitorId: betaVisitor, attributes: { ...pro, beta: false } },
    },
    {
      name: 'flag-rings: a ring with rules and ids does not match on the ID alone',
      input: { key: ringed.key, visitorId: betaVisitor, attributes: pro },
    },
    { name: 'flag-rings: no ring matches, bucketed', input: { key: ringed.key, visitorId: visitor, attributes: pro } },
    { name: 'flag-customer: ring by customer ID serves On', input: { key: byCustomer.key, id: 'Cust-1' } },
    {
      name: 'flag-customer: customer IDs in a ring are case-sensitive (cust-1 is bucketed)',
      input: { key: byCustomer.key, id: 'cust-1' },
    },
    { name: 'flag-customer: ring by customer ID serves Off', input: { key: byCustomer.key, id: 'vip-7' } },
    ...['42', 'customer-42', 'Kund-ÅÄÖ'].map((id) => ({
      name: `flag-customer: customer ${id} is bucketed on the enrolment ID`,
      input: { key: byCustomer.key, id },
    })),
    { name: 'flag-customer: reason wrong-id-kind', input: { key: byCustomer.key, visitorId: visitor } },
    { name: 'flag-on-lowest-id: Off is the variant that is not On', input: { key: onLowestId.key } },
    { name: 'flag-on-lowest-id: enrolled On', input: { key: onLowestId.key, visitorId: visitor } },
    { name: 'flag-unknown-on-variant: not-running, Off', input: { key: unknownOn.key, visitorId: visitor } },
    { name: 'flag-three-variants: not-running', input: { key: threeVariants.key, visitorId: visitor } },
    { name: 'flag-rollout-not-object: not-running', input: { key: rolloutNotObject.key, visitorId: visitor } },
    { name: 'flag-rings-not-list: not-running', input: { key: ringsNotList.key, visitorId: visitor } },
    { name: 'flag-odd-rings: malformed rings never match', input: { key: oddRings.key, visitorId: visitor } },
    {
      name: 'flag-odd-rings: a ring without rules matches on its ids',
      input: { key: oddRings.key, visitorId: oddRingVisitor },
    },
    { name: 'flag-deployed: the deployed variant, not-running', input: { key: deployed.key, visitorId: visitor } },
    { name: 'flag-null-rings: null rings are no rings', input: { key: nullRings.key, visitorId: visitor } },
    {
      name: 'rollout-null-is-a-split: rollout null splits by weight',
      input: { key: rolloutNull.key, visitorId: visitor },
    },
  ];

  const variantMapCases: RolloutVariantMapCase[] = [
    { name: 'flags: visitor ID only', input: { visitorId: visitor } },
    {
      name: 'flags: visitor ID with eligible staff attributes',
      input: { visitorId: visitor, attributes: { ...pro, staff: true } },
    },
    { name: 'flags: customer ID in a ring', input: { id: 'Cust-1' } },
    { name: 'flags: both IDs, bucketed', input: { visitorId: visitor, id: 'cust-1', attributes: pro } },
    { name: 'flags: no ID', input: {} },
  ];

  return { config, decisionCases, variantMapCases };
}
