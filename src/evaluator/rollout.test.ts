import type { Attributes, Decision, SdkConfig, SdkExperiment, SdkRing, SdkRollout } from './types';
import { beforeAll, describe, expect, test } from 'bun:test';
import { bucketFor } from './bucket';
import { SDK_CONFIG_VERSION } from './constants';
import { decide, decideAll, variantMapFor } from './decide';
import { deriveEnrolmentId } from './enrolment-id';
import { clampBasisPoints, rolloutLimit } from './rollout';

const SALT = '9c1f0e6b2a7d4c3e8f5a1b0d2c4e6f8a9c1f0e6b2a7d4c3e8f5a1b0d2c4e6f8a';
const VISITOR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const FLAG_ID = 40;

const OFF = { variantId: 401, variantKey: 'off', payload: { enabled: false } };
const ON = { variantId: 402, variantKey: 'on', payload: { enabled: true } };

const flag = (rollout: Partial<SdkRollout>, overrides: Partial<SdkExperiment> = {}): SdkExperiment => ({
  id: FLAG_ID,
  key: 'new-search',
  status: 'Running',
  bucketOn: 'visitor',
  variants: [
    { id: 402, key: 'on', weight: 5000, payload: { enabled: true } },
    { id: 401, key: 'off', weight: 5000, payload: { enabled: false } },
  ],
  deployedVariantId: null,
  targeting: [],
  rollout: { onVariantId: 402, rolloutBp: 0, holdbackBp: 0, rings: [], ...rollout },
  ...overrides,
});

const config = (experiments: SdkExperiment[]): SdkConfig => ({
  version: SDK_CONFIG_VERSION,
  websiteId: 1,
  generatedAt: 1_760_000_000_000,
  trackingMethod: 'server',
  experiments,
});

type DecideFlagParams = { experiment: SdkExperiment; visitorId?: string; id?: string; attributes?: Attributes };

const decideFlag = ({ experiment, ...identity }: DecideFlagParams): Promise<Decision> =>
  decide({ config: config([experiment]), salt: SALT, key: experiment.key, ...identity });

const bucketOf = (id: string): Promise<number> => bucketFor({ salt: SALT, experimentId: FLAG_ID, id });

/** The buckets the boundary tests need a visitor ID in. */
const BOUNDARY_BUCKETS = [0, 2499, 2500, 8999, 9000, 9999];
const boundaryVisitors = new Map<number, string>();

/**
 * One batched search for every boundary bucket at once, before any test: searching bucket by
 * bucket, one HMAC at a time, took over 5 s under the full suite's load.
 */
beforeAll(async () => {
  const batch = 4096;
  for (let start = 0; start < 1_000_000 && boundaryVisitors.size < BOUNDARY_BUCKETS.length; start += batch) {
    const ids = Array.from({ length: batch }, (_, offset) => {
      return `00000000-0000-4000-8000-${(start + offset).toString(16).padStart(12, '0')}`;
    });
    const buckets = await Promise.all(ids.map(bucketOf));
    buckets.forEach((bucket, index) => {
      if (BOUNDARY_BUCKETS.includes(bucket) && !boundaryVisitors.has(bucket)) boundaryVisitors.set(bucket, ids[index]!);
    });
  }
}, 60_000);

/** A visitor ID whose bucket in the test flag is exactly `target` (one of BOUNDARY_BUCKETS). */
function visitorInBucket(target: number): string {
  const id = boundaryVisitors.get(target);
  if (!id) throw new Error(`no visitor ID found for bucket ${target}`);
  return id;
}

describe('sticky rollout', () => {
  // 100k random IDs, decided through `decide` at every step. About 7 s.
  test('raising the rollout only adds people: nobody ever goes from On to Off', async () => {
    const ids = Array.from({ length: 100_000 }, () => crypto.randomUUID());
    const steps = [0, 100, 500, 1000, 2500, 5000, 7500, 9000, 9900, 10000];
    let wasOn = new Array<boolean>(ids.length).fill(false);

    for (const rolloutBp of steps) {
      const experiment = flag({ rolloutBp });
      const decisions = await Promise.all(ids.map((visitorId) => decideFlag({ experiment, visitorId })));
      const isOn = decisions.map((decision) => decision.variantId === ON.variantId);

      const turnedOff = isOn.filter((on, index) => wasOn[index] && !on).length;
      expect(turnedOff).toBe(0);
      expect(decisions.every((decision) => decision.enrolled)).toBe(true);
      // The share On tracks the step (100k IDs: a standard error of about 0.16 points).
      const share = isOn.filter(Boolean).length / ids.length;
      expect(Math.abs(share - rolloutBp / 10000)).toBeLessThan(0.01);
      wasOn = isOn;
    }
    expect(wasOn.every(Boolean)).toBe(true);
  }, 60_000);

  test('the holdback is Off at every step, 100% included, and the rest still only gains', async () => {
    const ids = Array.from({ length: 100_000 }, () => crypto.randomUUID());
    const buckets = await Promise.all(ids.map(bucketOf));
    const heldBack = buckets.map((bucket) => bucket >= 9000);
    let wasOn = new Array<boolean>(ids.length).fill(false);

    for (const rolloutBp of [0, 2500, 5000, 9000, 10000]) {
      const experiment = flag({ rolloutBp, holdbackBp: 1000 });
      const decisions = await Promise.all(ids.map((visitorId) => decideFlag({ experiment, visitorId })));
      const isOn = decisions.map((decision) => decision.variantId === ON.variantId);

      expect(isOn.some((on, index) => on && heldBack[index])).toBe(false);
      expect(isOn.filter((on, index) => wasOn[index] && !on).length).toBe(0);
      expect(isOn).toEqual(buckets.map((bucket) => bucket < Math.min(rolloutBp, 9000)));
      wasOn = isOn;
    }
  }, 60_000);

  test('the boundary: bucket limit - 1 is On, bucket limit is Off, both enrolled', async () => {
    const below = visitorInBucket(2499);
    const at = visitorInBucket(2500);
    const experiment = flag({ rolloutBp: 2500 });
    expect(await decideFlag({ experiment, visitorId: below })).toEqual({
      experimentId: FLAG_ID,
      ...ON,
      enrolled: true,
    });
    expect(await decideFlag({ experiment, visitorId: at })).toEqual({ experimentId: FLAG_ID, ...OFF, enrolled: true });
  });

  test('the holdback boundary: with 10% held back, bucket 8999 is On and 9000 is Off at 100%', async () => {
    const experiment = flag({ rolloutBp: 10000, holdbackBp: 1000 });
    const below = await decideFlag({ experiment, visitorId: visitorInBucket(8999) });
    const at = await decideFlag({ experiment, visitorId: visitorInBucket(9000) });
    expect(below.variantId).toBe(ON.variantId);
    expect(at).toEqual({ experimentId: FLAG_ID, ...OFF, enrolled: true });
  });

  test('a visitor ID buckets the same in any case', async () => {
    const experiment = flag({ rolloutBp: 5000 });
    const lower = await decideFlag({ experiment, visitorId: VISITOR });
    expect(await decideFlag({ experiment, visitorId: VISITOR.toUpperCase() })).toEqual(lower);
  });
});

describe('clamping', () => {
  test('basis points are floored and clamped to 0..10000; anything that is not a finite number is 0', () => {
    expect(clampBasisPoints(2500.9)).toBe(2500);
    expect(clampBasisPoints(-1)).toBe(0);
    expect(clampBasisPoints(25000)).toBe(10000);
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5000', null, undefined, {}]) {
      expect(clampBasisPoints(odd)).toBe(0);
    }
  });

  test('the limit is min(rollout, 10000 - holdback) after clamping', () => {
    expect(rolloutLimit(2500, 0)).toBe(2500);
    expect(rolloutLimit(10000, 1000)).toBe(9000);
    expect(rolloutLimit(5000, 7000)).toBe(3000);
    expect(rolloutLimit(25000, -50)).toBe(10000);
    expect(rolloutLimit(-1, 0)).toBe(0);
    expect(rolloutLimit(5000, 20000)).toBe(0);
    expect(rolloutLimit('10000', 0)).toBe(0);
  });

  test('a rollout above 10000 is everyone On; a negative one or a full holdback is everyone Off, enrolled', async () => {
    const top = visitorInBucket(9999);
    expect(
      (await decideFlag({ experiment: flag({ rolloutBp: 25000, holdbackBp: -50 }), visitorId: top })).variantId,
    ).toBe(ON.variantId);
    for (const rollout of [{ rolloutBp: -1 }, { rolloutBp: 10000, holdbackBp: 20000 }]) {
      const bottom = visitorInBucket(0);
      expect(await decideFlag({ experiment: flag(rollout), visitorId: bottom })).toEqual({
        experimentId: FLAG_ID,
        ...OFF,
        enrolled: true,
      });
    }
  });
});

describe('rings', () => {
  const staff = { rules: [{ attribute: 'staff', operator: 'equals' as const, value: true }], serve: 'on' as const };

  test('a ring decides before the bucket: that side, reason ring, not enrolled', async () => {
    const experiment = flag({ rolloutBp: 0, rings: [staff] });
    expect(await decideFlag({ experiment, visitorId: VISITOR, attributes: { staff: true } })).toEqual({
      experimentId: FLAG_ID,
      ...ON,
      enrolled: false,
      reason: 'ring',
    });
    expect(await decideFlag({ experiment, visitorId: VISITOR, attributes: { staff: false } })).toEqual({
      experimentId: FLAG_ID,
      ...OFF,
      enrolled: true,
    });
  });

  test('an Off ring holds people back even at 100%', async () => {
    const experiment = flag({ rolloutBp: 10000, rings: [{ rules: [], ids: [VISITOR], serve: 'off' }] });
    expect(await decideFlag({ experiment, visitorId: VISITOR })).toEqual({
      experimentId: FLAG_ID,
      ...OFF,
      enrolled: false,
      reason: 'ring',
    });
  });

  test('the first matching ring wins', async () => {
    const listedOff = { rules: [], ids: [VISITOR], serve: 'off' as const };
    const staffFirst = flag({ rolloutBp: 5000, rings: [staff, listedOff] });
    const listFirst = flag({ rolloutBp: 5000, rings: [listedOff, staff] });
    const identity = { visitorId: VISITOR, attributes: { staff: true } };
    expect((await decideFlag({ experiment: staffFirst, ...identity })).variantId).toBe(ON.variantId);
    expect((await decideFlag({ experiment: listFirst, ...identity })).variantId).toBe(OFF.variantId);
  });

  test('a ring with rules and ids needs both', async () => {
    const both = { rules: [{ attribute: 'beta', operator: 'exists' as const }], ids: [VISITOR], serve: 'on' as const };
    const experiment = flag({ rolloutBp: 0, rings: [both] });
    const other = '00000000-0000-4000-8000-000000000001';
    expect(await decideFlag({ experiment, visitorId: VISITOR, attributes: { beta: 1 } })).toMatchObject({
      reason: 'ring',
    });
    expect(await decideFlag({ experiment, visitorId: VISITOR })).toMatchObject({ enrolled: true, ...OFF });
    expect(await decideFlag({ experiment, visitorId: other, attributes: { beta: 1 } })).toMatchObject({
      enrolled: true,
      ...OFF,
    });
  });

  test('visitor IDs in a ring match in any case; customer IDs match exactly', async () => {
    const byVisitor = flag({ rings: [{ rules: [], ids: [VISITOR.toUpperCase()], serve: 'on' }] });
    expect(await decideFlag({ experiment: byVisitor, visitorId: VISITOR })).toMatchObject({ reason: 'ring', ...ON });

    const byCustomer = flag({ rings: [{ rules: [], ids: ['Cust-1'], serve: 'on' }] }, { bucketOn: 'customer_id' });
    expect(await decideFlag({ experiment: byCustomer, id: 'Cust-1' })).toMatchObject({ reason: 'ring', ...ON });
    expect(await decideFlag({ experiment: byCustomer, id: 'cust-1' })).toMatchObject({ enrolled: true, ...OFF });
  });

  test('eligibility comes before rings: an ineligible staff member is Off, targeting', async () => {
    const experiment = flag(
      { rolloutBp: 10000, rings: [staff] },
      { targeting: [{ attribute: 'plan', operator: 'equals', value: 'pro' }] },
    );
    expect(await decideFlag({ experiment, visitorId: VISITOR, attributes: { staff: true, plan: 'free' } })).toEqual({
      experimentId: FLAG_ID,
      ...OFF,
      enrolled: false,
      reason: 'targeting',
    });
    expect(
      await decideFlag({ experiment, visitorId: VISITOR, attributes: { staff: true, plan: 'pro' } }),
    ).toMatchObject({ reason: 'ring', ...ON });
  });

  test('the ID checks come before rings: a ring cannot let in someone with no ID', async () => {
    const experiment = flag({ rings: [{ rules: [], serve: 'on' }] });
    expect(await decideFlag({ experiment })).toEqual({
      experimentId: FLAG_ID,
      ...OFF,
      enrolled: false,
      reason: 'no-id',
    });
  });

  test('malformed rings never match and never throw', async () => {
    const odd = [
      null,
      'staff',
      { rules: [], serve: 'maybe' },
      { rules: 'staff', serve: 'on' },
      { rules: [], ids: VISITOR, serve: 'on' },
      { rules: [], ids: [42, null], serve: 'on' },
    ] as unknown as SdkRollout['rings'];
    const decision = await decideFlag({ experiment: flag({ rolloutBp: 0, rings: odd }), visitorId: VISITOR });
    expect(decision).toEqual({ experimentId: FLAG_ID, ...OFF, enrolled: true });
  });

  test('a ring with no rules and no ids matches everyone with an ID', async () => {
    const decision = await decideFlag({
      experiment: flag({ rings: [{ serve: 'on' } as unknown as SdkRing] }),
      visitorId: VISITOR,
    });
    expect(decision).toMatchObject({ reason: 'ring', ...ON });
  });
});

describe('malformed rollouts', () => {
  const notRunning: Decision = { experimentId: FLAG_ID, ...OFF, enrolled: false, reason: 'not-running' };

  test('a rollout naming a variant the experiment does not have: Off, not-running', async () => {
    const decision = await decideFlag({ experiment: flag({ onVariantId: 999, rolloutBp: 10000 }), visitorId: VISITOR });
    expect(decision).toEqual(notRunning);
  });

  test('a flag that is not exactly two variants: not-running, never a throw', async () => {
    const three = flag(
      { rolloutBp: 10000 },
      {
        variants: [...flag({}).variants, { id: 403, key: 'extra', weight: 0, payload: null }],
      },
    );
    expect(await decideFlag({ experiment: three, visitorId: VISITOR })).toEqual(notRunning);

    const onlyOn = flag({ rolloutBp: 10000 }, { variants: [{ id: 402, key: 'on', weight: 0, payload: null }] });
    expect(await decideFlag({ experiment: onlyOn, visitorId: VISITOR })).toEqual({
      experimentId: FLAG_ID,
      variantId: null,
      variantKey: null,
      payload: null,
      enrolled: false,
      reason: 'not-running',
    });

    const sameIds = flag(
      { onVariantId: 401, rolloutBp: 10000 },
      {
        variants: [
          { id: 401, key: 'a', weight: 0, payload: null },
          { id: 401, key: 'b', weight: 0, payload: null },
        ],
      },
    );
    expect(await decideFlag({ experiment: sameIds, visitorId: VISITOR })).toMatchObject({ reason: 'not-running' });
  });

  test('a rollout that is not an object, or rings that are not a list: not-running', async () => {
    for (const rollout of ['full', 1, [], true]) {
      const experiment = { ...flag({}), rollout } as unknown as SdkExperiment;
      expect(await decideFlag({ experiment, visitorId: VISITOR })).toEqual(notRunning);
    }
    const ringsObject = flag({ rolloutBp: 10000, rings: {} as unknown as SdkRollout['rings'] });
    expect(await decideFlag({ experiment: ringsObject, visitorId: VISITOR })).toEqual(notRunning);
  });

  test('null or absent rings are no rings', async () => {
    const experiment = flag({ rolloutBp: 10000, rings: null as unknown as SdkRollout['rings'] });
    expect(await decideFlag({ experiment, visitorId: VISITOR })).toEqual({
      experimentId: FLAG_ID,
      ...ON,
      enrolled: true,
    });
  });

  test('rollout null is an ordinary experiment, split by weight', async () => {
    const experiment = { ...flag({}), rollout: null } as unknown as SdkExperiment;
    const decision = await decideFlag({ experiment, visitorId: VISITOR });
    const bucket = await bucketOf(VISITOR);
    expect(decision.variantId).toBe(bucket < 5000 ? 401 : 402);
  });
});

describe('flag statuses and IDs', () => {
  test('Off is the variant that is not On, even when On has the lower id', async () => {
    const decision = await decideFlag({ experiment: flag({}) });
    expect(decision).toEqual({ experimentId: FLAG_ID, ...OFF, enrolled: false, reason: 'no-id' });
  });

  test('not running: Deployed answers the deployed variant, any other status Off', async () => {
    const deployed = flag({}, { status: 'Deployed', deployedVariantId: 402 });
    expect(await decideFlag({ experiment: deployed })).toMatchObject({ ...ON, reason: 'not-running' });
    const paused = flag({ rolloutBp: 10000 }, { status: 'Paused' as unknown as 'Running' });
    expect(await decideFlag({ experiment: paused, visitorId: VISITOR })).toMatchObject({
      ...OFF,
      reason: 'not-running',
    });
  });

  test('a visitor flag refuses a customer ID: Off, wrong-id-kind', async () => {
    expect(await decideFlag({ experiment: flag({ rolloutBp: 10000 }), id: 'cust-1' })).toEqual({
      experimentId: FLAG_ID,
      ...OFF,
      enrolled: false,
      reason: 'wrong-id-kind',
    });
  });

  test('a customer-ID flag buckets on the enrolment ID and enrols as it, On or Off', async () => {
    const experiment = flag({ rolloutBp: 5000 }, { bucketOn: 'customer_id' });
    for (const id of ['Cust-1', 'cust-1', 'customer-42', '42']) {
      const enrolAs = await deriveEnrolmentId({ salt: SALT, customerId: id });
      const bucket = await bucketOf(enrolAs);
      expect(await decideFlag({ experiment, id })).toEqual({
        experimentId: FLAG_ID,
        ...(bucket < 5000 ? ON : OFF),
        enrolled: true,
        enrolAs,
      });
    }
  });
});

describe('flags in decideAll and variantMapFor', () => {
  const experiments = [
    flag({ rolloutBp: 10000 }),
    flag({ rolloutBp: 0 }, { id: 41, key: 'dark-flag' }),
    flag({ rolloutBp: 10000, rings: [{ rules: [], ids: [VISITOR], serve: 'on' }] }, { id: 42, key: 'ringed' }),
    flag({ rolloutBp: 10000 }, { id: 43, key: 'customer-flag', bucketOn: 'customer_id' }),
  ];

  test('decideAll decides every flag', async () => {
    const all = await decideAll({ config: config(experiments), salt: SALT, visitorId: VISITOR });
    expect(all['new-search']).toMatchObject({ ...ON, enrolled: true });
    expect(all['dark-flag']).toMatchObject({ ...OFF, enrolled: true });
    expect(all['ringed']).toMatchObject({ ...ON, enrolled: false, reason: 'ring' });
    expect(all['customer-flag']).toMatchObject({ ...OFF, reason: 'wrong-id-kind' });
  });

  test('the variant map holds enrolled flags, On and Off, and never a ring decision', async () => {
    const map = await variantMapFor({ config: config(experiments), salt: SALT, visitorId: VISITOR, id: 'cust-1' });
    expect(map).toEqual({ '40': '402', '41': '401', '43': '402' });
  });
});
