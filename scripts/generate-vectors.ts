/**
 * Writes spec/vectors.json from the evaluator itself.
 *
 *   bun scripts/generate-vectors.ts            # refuses to overwrite
 *   bun scripts/generate-vectors.ts --force    # only together with a spec version bump
 *
 * The vectors are the contract every port (and every later change to this package) is
 * held to, so they are generated once, after the RFC 4231 HMAC test passes, and then
 * committed. Regenerating them silently would turn "the implementation is wrong" into
 * "the vectors moved", which is exactly what they exist to catch.
 */
import type {
  BucketOn,
  DecideIdentity,
  Decision,
  SdkConfig,
  SdkExperiment,
  SdkVariant,
} from '../src/evaluator';
import type { RolloutDecisionCase, RolloutVariantMapCase } from './rollout-cases';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  bucketFor,
  CONFIG_VERSION_WITHOUT_ROLLOUTS,
  decide,
  deriveEnrolmentId,
  pickByBucket,
  SDK_CONFIG_VERSION,
  variantMapFor,
} from '../src/evaluator';
import { buildRolloutCases } from './rollout-cases';

const OUT = resolve(import.meta.dir, '../spec/vectors.json');

const SALT_A = '5f1d3c9a7e2b4d6f8a0c1e3f5a7b9d1c3e5f7a9b1d3f5e7c9a1b3d5f7e9c1a3b';
const SALT_B = '00ff10ee20dd30cc40bb50aa60997088';

const BUCKET_IDS = [
  '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  '3F2504E0-4F89-41D3-9A0C-0305E82C3301',
  'b7c6a1e2-0d4f-4a8b-9c3e-5f6a7b8c9d0e',
  'customer-42',
  'Customer-42',
  '42',
  'jane.doe@example.com',
  'Kund-ÅÄÖ',
  '顧客-7',
  '🙂user',
  'İstanbul',
  'ΟΔΟΣ',
];

const ENROLMENT_CUSTOMER_IDS = [
  '42',
  'customer-42',
  'Customer-42',
  'jane.doe@example.com',
  'Kund-ÅÄÖ',
  '顧客-7',
  '🙂user',
];

const VISITOR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const experiment = (overrides: Partial<SdkExperiment>): SdkExperiment => ({
  id: 501,
  key: 'new-checkout',
  status: 'Running',
  bucketOn: 'visitor',
  variants: [
    { id: 9001, key: 'control', weight: 5000, payload: { layout: 'classic' } },
    { id: 9002, key: 'one-page', weight: 5000, payload: { layout: 'single', steps: 1 } },
  ],
  deployedVariantId: null,
  targeting: [],
  ...overrides,
});

// No rollouts, so version 1: a version 2 reader decides it exactly as a version 1 reader does.
const CONFIG: SdkConfig = {
  version: CONFIG_VERSION_WITHOUT_ROLLOUTS,
  websiteId: 77,
  generatedAt: 1_760_400_000_000,
  trackingMethod: 'server',
  experiments: [
    experiment({}),
    experiment({
      id: 502,
      key: 'pricing-page',
      bucketOn: 'customer_id',
      variants: [
        { id: 9011, key: 'control', weight: 3334, payload: null },
        { id: 9012, key: 'annual-first', weight: 3333, payload: { default: 'annual' } },
        { id: 9013, key: 'monthly-first', weight: 3333, payload: { default: 'monthly' } },
      ],
    }),
    experiment({
      id: 503,
      key: 'pro-banner',
      variants: [
        { id: 9021, key: 'off', weight: 2000, payload: false },
        { id: 9022, key: 'on', weight: 8000, payload: true },
      ],
      targeting: [
        { attribute: 'plan', operator: 'in', value: ['pro', 'business'] },
        { attribute: 'country', operator: 'not in', value: ['US'] },
        { attribute: 'seats', operator: '>', value: 1 },
        { attribute: 'beta', operator: 'exists' },
      ],
    }),
    experiment({
      id: 504,
      key: 'old-search',
      status: 'Deployed',
      variants: [
        { id: 9031, key: 'control', weight: 5000, payload: 'v1' },
        { id: 9032, key: 'fuzzy', weight: 5000, payload: 'v2' },
        { id: 9033, key: 'fuzzy', weight: 0, payload: 'v2' },
      ],
      deployedVariantId: 9033,
    }),
    experiment({
      id: 505,
      key: 'uneven-weights',
      variants: [
        { id: 9042, key: 'b', weight: 30, payload: null },
        { id: 9041, key: 'a', weight: 70, payload: null },
      ],
    }),
    // Everything below exists for one spec branch each. Their targeting names attributes no
    // variant-map input carries, so the variant maps are the same as without them.
    experiment({
      id: 506,
      key: 'all-zero-weights',
      variants: [
        { id: 9051, key: 'control', weight: 0, payload: 'c' },
        { id: 9052, key: 'treatment', weight: 0, payload: 't' },
      ],
    }),
    experiment({ id: 507, key: 'deployed-without-variant-id', status: 'Deployed', deployedVariantId: null }),
    experiment({ id: 508, key: 'deployed-naming-no-variant', status: 'Deployed', deployedVariantId: 9999 }),
    experiment({ id: 509, key: 'no-variants', variants: [] }),
    experiment({
      id: 510,
      key: 'unknown-status',
      // The writer emits only Running and Deployed; any other status is not running, with control.
      status: 'Paused' as unknown as SdkExperiment['status'],
      deployedVariantId: 9002,
    }),
    experiment({ id: 511, key: 'unknown-bucket-on', bucketOn: 'account' as unknown as BucketOn }),
    experiment({
      id: 512,
      key: 'equals-string',
      targeting: [{ attribute: 'tier', operator: 'equals', value: 'gold' }],
    }),
    experiment({ id: 513, key: 'equals-number', targeting: [{ attribute: 'level', operator: 'equals', value: 3 }] }),
    experiment({
      id: 514,
      key: 'equals-boolean',
      targeting: [{ attribute: 'verified', operator: 'equals', value: true }],
    }),
    experiment({ id: 515, key: 'less-than', targeting: [{ attribute: 'score', operator: '<', value: 50 }] }),
    experiment({ id: 516, key: 'exists', targeting: [{ attribute: 'referrer', operator: 'exists' }] }),
    experiment({
      id: 517,
      key: 'in-list',
      targeting: [{ attribute: 'region', operator: 'in', value: ['eu', 'apac', 7] }],
    }),
  ],
};

type DecisionCase = { name: string; input: DecideIdentity & { key: string } };

const PRO_ATTRIBUTES = { plan: 'pro', country: 'SE', seats: 5, beta: true };

const DECISION_CASES: DecisionCase[] = [
  ...[
    '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    'b7c6a1e2-0d4f-4a8b-9c3e-5f6a7b8c9d0e',
    'C0FFEE00-1234-4ABC-8DEF-0123456789AB',
  ].map((visitorId, index) => ({
    name: `visitor experiment, visitor ${index + 1}`,
    input: { key: 'new-checkout', visitorId },
  })),
  ...['42', 'customer-42', 'Kund-ÅÄÖ', 'Cust-1', 'cust-1'].map((id) => ({
    name: `customer-id experiment, customer ${id}`,
    input: { key: 'pricing-page', id },
  })),
  { name: 'targeting match', input: { key: 'pro-banner', visitorId: VISITOR, attributes: PRO_ATTRIBUTES } },
  ...[2, 4, 6].map((n) => ({
    name: `weights not summing to 10000, visitor ${n}`,
    input: { key: 'uneven-weights', visitorId: `00000000-0000-4000-8000-00000000000${n}` },
  })),
  { name: 'reason unknown-key', input: { key: 'does-not-exist', visitorId: VISITOR } },
  {
    name: 'reason not-running (Deployed returns the deployed variant)',
    input: { key: 'old-search', visitorId: VISITOR },
  },
  { name: 'reason not-running without any ID', input: { key: 'old-search' } },
  { name: 'reason no-id', input: { key: 'new-checkout' } },
  { name: 'reason no-id (empty strings)', input: { key: 'new-checkout', visitorId: '', id: '' } },
  { name: 'reason wrong-id-kind (visitor experiment, customer ID)', input: { key: 'new-checkout', id: 'customer-42' } },
  {
    name: 'reason wrong-id-kind (customer experiment, visitor ID)',
    input: { key: 'pricing-page', visitorId: VISITOR },
  },
  {
    name: 'reason targeting (not in matches US)',
    input: { key: 'pro-banner', visitorId: VISITOR, attributes: { ...PRO_ATTRIBUTES, country: 'US' } },
  },
  {
    name: 'reason targeting (missing attribute fails not in)',
    input: { key: 'pro-banner', visitorId: VISITOR, attributes: { plan: 'pro', seats: 5, beta: true } },
  },
  {
    name: 'reason targeting (numeric string is not a number)',
    input: { key: 'pro-banner', visitorId: VISITOR, attributes: { ...PRO_ATTRIBUTES, seats: '5' } },
  },
  { name: 'reason targeting (no attributes)', input: { key: 'pro-banner', visitorId: VISITOR } },
  {
    name: 'Running with every weight 0 admits nobody (not-running)',
    input: { key: 'all-zero-weights', visitorId: VISITOR },
  },
  { name: 'Deployed with deployedVariantId null returns control', input: { key: 'deployed-without-variant-id' } },
  { name: 'Deployed naming no variant returns control', input: { key: 'deployed-naming-no-variant' } },
  { name: 'experiment with no variants (all null, not-running)', input: { key: 'no-variants', visitorId: VISITOR } },
  {
    name: 'status other than Running or Deployed returns control, not the deployed variant',
    input: { key: 'unknown-status', visitorId: VISITOR },
  },
  {
    name: 'unknown bucketOn enrols nobody (wrong-id-kind)',
    input: { key: 'unknown-bucket-on', visitorId: VISITOR, id: 'customer-42' },
  },
  { name: 'unknown bucketOn without any ID', input: { key: 'unknown-bucket-on' } },
  { name: 'equals string matches', input: { key: 'equals-string', visitorId: VISITOR, attributes: { tier: 'gold' } } },
  {
    name: 'equals string is case-sensitive',
    input: { key: 'equals-string', visitorId: VISITOR, attributes: { tier: 'Gold' } },
  },
  { name: 'equals number matches', input: { key: 'equals-number', visitorId: VISITOR, attributes: { level: 3 } } },
  {
    name: 'equals number: "3" is not 3',
    input: { key: 'equals-number', visitorId: VISITOR, attributes: { level: '3' } },
  },
  {
    name: 'equals boolean matches true',
    input: { key: 'equals-boolean', visitorId: VISITOR, attributes: { verified: true } },
  },
  {
    name: 'equals boolean: "true" is not true',
    input: { key: 'equals-boolean', visitorId: VISITOR, attributes: { verified: 'true' } },
  },
  { name: '< matches below the value', input: { key: 'less-than', visitorId: VISITOR, attributes: { score: 49.5 } } },
  { name: '< fails at the value', input: { key: 'less-than', visitorId: VISITOR, attributes: { score: 50 } } },
  {
    name: 'exists matches a present falsy value',
    input: { key: 'exists', visitorId: VISITOR, attributes: { referrer: '' } },
  },
  { name: 'exists fails when missing', input: { key: 'exists', visitorId: VISITOR, attributes: { other: 'x' } } },
  { name: 'exists fails when null', input: { key: 'exists', visitorId: VISITOR, attributes: { referrer: null } } },
  { name: 'in matches a string', input: { key: 'in-list', visitorId: VISITOR, attributes: { region: 'apac' } } },
  { name: 'in matches a number', input: { key: 'in-list', visitorId: VISITOR, attributes: { region: 7 } } },
  { name: 'in fails outside the list', input: { key: 'in-list', visitorId: VISITOR, attributes: { region: 'us' } } },
  { name: 'in: "7" is not 7', input: { key: 'in-list', visitorId: VISITOR, attributes: { region: '7' } } },
];

type WeightWalkCase = { name: string; variants: SdkVariant[]; buckets: number[] };

const walkVariant = (id: number, weight: number): SdkVariant => ({ id, key: `v${id}`, weight, payload: null });

/**
 * The weight walk at chosen buckets, so a port with a different scaling (`bucket % total`
 * instead of `floor(bucket * total / 10000)`) or boundary (`<=` instead of `<`) fails.
 */
const WEIGHT_WALK_CASES: WeightWalkCase[] = [
  {
    name: '70/30 in basis points',
    variants: [walkVariant(1, 7000), walkVariant(2, 3000)],
    buckets: [0, 6999, 7000, 9999],
  },
  {
    name: '70/30 totalling 100 (scaled)',
    variants: [walkVariant(1, 70), walkVariant(2, 30)],
    buckets: [0, 6999, 7000, 9999],
  },
  {
    name: '70/30 totalling 100, given out of id order',
    variants: [walkVariant(2, 30), walkVariant(1, 70)],
    buckets: [6999, 7000],
  },
  {
    name: 'weights totalling 15000 (scaled down)',
    variants: [walkVariant(1, 6000), walkVariant(2, 9000)],
    buckets: [0, 3999, 4000, 9999],
  },
  {
    name: 'three-way 3334/3333/3333',
    variants: [walkVariant(1, 3334), walkVariant(2, 3333), walkVariant(3, 3333)],
    buckets: [3333, 3334, 6666, 6667, 9999],
  },
  {
    name: 'zero, negative and fractional weights',
    variants: [walkVariant(1, 0), walkVariant(2, -500), walkVariant(3, 2500.9), walkVariant(4, 7500)],
    buckets: [0, 2499, 2500, 9999],
  },
  { name: 'every weight 0', variants: [walkVariant(1, 0), walkVariant(2, 0)], buckets: [0, 9999] },
  { name: 'no variants', variants: [], buckets: [0] },
];

type VariantMapCase = { name: string; input: DecideIdentity };

const VARIANT_MAP_CASES: VariantMapCase[] = [
  { name: 'visitor ID only', input: { visitorId: VISITOR } },
  { name: 'visitor ID with matching attributes', input: { visitorId: VISITOR, attributes: PRO_ATTRIBUTES } },
  { name: 'customer ID only', input: { id: 'customer-42' } },
  { name: 'customer ID Cust-1 (case-sensitive)', input: { id: 'Cust-1' } },
  { name: 'customer ID cust-1 (case-sensitive)', input: { id: 'cust-1' } },
  {
    name: 'both IDs with matching attributes',
    input: { visitorId: VISITOR, id: 'customer-42', attributes: PRO_ATTRIBUTES },
  },
  { name: 'no ID', input: {} },
];

/** The bucket an enrolled flag decision was made at: on enrolAs for a customer ID, else the visitor ID. */
async function enrolledBucket(decision: Decision, visitorId: string | undefined): Promise<number | null> {
  if (!decision.enrolled) return null;
  const id = decision.enrolAs ?? visitorId;
  return id === undefined ? null : bucketFor({ salt: SALT_A, experimentId: decision.experimentId, id });
}

async function main(): Promise<void> {
  if (existsSync(OUT) && !process.argv.includes('--force')) {
    console.error(`${OUT} exists. Vectors change only with a spec version bump; pass --force if that is what this is.`);
    process.exit(1);
  }

  const buckets = [];
  for (const salt of [SALT_A, SALT_B]) {
    for (const experimentId of [1, 501, 2147483647]) {
      for (const id of BUCKET_IDS) {
        // `message` is the exact string hashed, so a port can tell a case-mapping bug from a hashing bug.
        const message = `${experimentId}:${id.toLowerCase()}`;
        buckets.push({ salt, experimentId, id, message, bucket: await bucketFor({ salt, experimentId, id }) });
      }
    }
  }

  const enrolmentIds = [];
  for (const salt of [SALT_A, SALT_B]) {
    for (const customerId of ENROLMENT_CUSTOMER_IDS) {
      enrolmentIds.push({ salt, customerId, enrolmentId: await deriveEnrolmentId({ salt, customerId }) });
    }
  }

  const decisions: Array<DecisionCase & { expected: Decision }> = [];
  for (const { name, input } of DECISION_CASES) {
    decisions.push({ name, input, expected: await decide({ config: CONFIG, salt: SALT_A, ...input }) });
  }

  const weightWalks = [];
  for (const { name, variants, buckets: walkBuckets } of WEIGHT_WALK_CASES) {
    for (const bucket of walkBuckets) {
      weightWalks.push({ name, variants, bucket, expected: pickByBucket(variants, bucket)?.id ?? null });
    }
  }

  const variantMaps: Array<VariantMapCase & { expected: Record<string, string> }> = [];
  for (const { name, input } of VARIANT_MAP_CASES) {
    variantMaps.push({ name, input, expected: await variantMapFor({ config: CONFIG, salt: SALT_A, ...input }) });
  }

  const rollout = await buildRolloutCases({ salt: SALT_A, visitor: VISITOR });
  const rolloutDecisions: Array<RolloutDecisionCase & { bucket: number | null; expected: Decision }> = [];
  for (const { name, input } of rollout.decisionCases) {
    const expected = await decide({ config: rollout.config, salt: SALT_A, ...input });
    rolloutDecisions.push({ name, input, bucket: await enrolledBucket(expected, input.visitorId), expected });
  }
  const rolloutVariantMaps: Array<RolloutVariantMapCase & { expected: Record<string, string> }> = [];
  for (const { name, input } of rollout.variantMapCases) {
    rolloutVariantMaps.push({
      name,
      input,
      expected: await variantMapFor({ config: rollout.config, salt: SALT_A, ...input }),
    });
  }

  const file = {
    specVersion: SDK_CONFIG_VERSION,
    description:
      'Test vectors for spec/SPEC.md. buckets and enrolmentIds carry their own salt; decisions and variantMaps all use decisionSalt and decisionConfig; weightWalks give the variant id (or null) the weight walk picks at a bucket; rolloutDecisions and rolloutVariantMaps use decisionSalt and rolloutConfig (feature flags), and each rollout decision carries the bucket it was decided at when enrolled (null otherwise). decisionConfig has no rollouts and is version 1; rolloutConfig has them and is version 2.',
    buckets,
    enrolmentIds,
    weightWalks,
    decisionSalt: SALT_A,
    decisionConfig: CONFIG,
    decisions,
    variantMaps,
    rolloutConfig: rollout.config,
    rolloutDecisions,
    rolloutVariantMaps,
  };
  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
  console.log(
    `Wrote ${buckets.length} buckets, ${enrolmentIds.length} enrolment IDs, ${weightWalks.length} weight walks, ${decisions.length} decisions, ${variantMaps.length} variant maps, ${rolloutDecisions.length} rollout decisions, ${rolloutVariantMaps.length} rollout variant maps to ${OUT}`,
  );
}

await main();
