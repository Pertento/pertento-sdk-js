import type { SdkConfig, SdkExperiment } from './types';
import { describe, expect, test } from 'bun:test';
import { bucketFor } from './bucket';
import { decide, decideAll, variantMapFor } from './decide';
import { deriveEnrolmentId } from './enrolment-id';

const SALT = '9c1f0e6b2a7d4c3e8f5a1b0d2c4e6f8a9c1f0e6b2a7d4c3e8f5a1b0d2c4e6f8a';
const VISITOR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** Treatment takes all traffic, so an enrolled decision is always variant 102. */
const experiment = (overrides: Partial<SdkExperiment>): SdkExperiment => ({
  id: 10,
  key: 'new-checkout',
  status: 'Running',
  bucketOn: 'visitor',
  variants: [
    { id: 102, key: 'treatment', weight: 10000, payload: { color: 'green' } },
    { id: 101, key: 'control', weight: 0, payload: { color: 'blue' } },
  ],
  deployedVariantId: null,
  targeting: [],
  ...overrides,
});

const config = (experiments: SdkExperiment[]): SdkConfig => ({
  version: 1,
  websiteId: 1,
  generatedAt: 1_760_000_000_000,
  trackingMethod: 'server',
  experiments,
});

const CONTROL = { variantId: 101, variantKey: 'control', payload: { color: 'blue' } };

describe('decide', () => {
  test('enrols a Running visitor experiment by bucket', async () => {
    const decision = await decide({
      config: config([experiment({})]),
      salt: SALT,
      key: 'new-checkout',
      visitorId: VISITOR,
    });
    expect(decision).toEqual({
      experimentId: 10,
      variantId: 102,
      variantKey: 'treatment',
      payload: { color: 'green' },
      enrolled: true,
    });
  });

  test('a 50/50 split follows bucketFor', async () => {
    const split = experiment({
      variants: [
        { id: 101, key: 'control', weight: 5000, payload: null },
        { id: 102, key: 'treatment', weight: 5000, payload: null },
      ],
    });
    for (const visitorId of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const bucket = await bucketFor({ salt: SALT, experimentId: 10, id: visitorId });
      const decision = await decide({ config: config([split]), salt: SALT, key: 'new-checkout', visitorId });
      expect(decision.variantId).toBe(bucket < 5000 ? 101 : 102);
    }
  });

  test('unknown key: everything null', async () => {
    const decision = await decide({ config: config([experiment({})]), salt: SALT, key: 'nope', visitorId: VISITOR });
    expect(decision).toEqual({
      experimentId: null,
      variantId: null,
      variantKey: null,
      payload: null,
      enrolled: false,
      reason: 'unknown-key',
    });
  });

  test('Deployed returns the deployed variant, not enrolled, with or without an ID', async () => {
    const deployed = experiment({
      status: 'Deployed',
      deployedVariantId: 103,
      variants: [...experiment({}).variants, { id: 103, key: 'treatment', weight: 0, payload: { color: 'green' } }],
    });
    for (const identity of [{ visitorId: VISITOR }, {}]) {
      const decision = await decide({ config: config([deployed]), salt: SALT, key: 'new-checkout', ...identity });
      expect(decision).toEqual({
        experimentId: 10,
        variantId: 103,
        variantKey: 'treatment',
        payload: { color: 'green' },
        enrolled: false,
        reason: 'not-running',
      });
    }
  });

  test('Deployed without a usable deployedVariantId falls back to control', async () => {
    const deployed = experiment({ status: 'Deployed', deployedVariantId: 999 });
    const decision = await decide({ config: config([deployed]), salt: SALT, key: 'new-checkout' });
    expect(decision).toEqual({ experimentId: 10, ...CONTROL, enrolled: false, reason: 'not-running' });
  });

  test('an unexpected status is not running and returns control', async () => {
    const paused = experiment({ status: 'Paused' as unknown as 'Running' });
    const decision = await decide({ config: config([paused]), salt: SALT, key: 'new-checkout', visitorId: VISITOR });
    expect(decision).toEqual({ experimentId: 10, ...CONTROL, enrolled: false, reason: 'not-running' });
  });

  test('no ID at all: control, no-id', async () => {
    for (const identity of [{}, { visitorId: '' }, { id: '' }]) {
      const decision = await decide({ config: config([experiment({})]), salt: SALT, key: 'new-checkout', ...identity });
      expect(decision).toEqual({ experimentId: 10, ...CONTROL, enrolled: false, reason: 'no-id' });
    }
  });

  test('a visitor experiment refuses a customer ID: wrong-id-kind', async () => {
    const decision = await decide({ config: config([experiment({})]), salt: SALT, key: 'new-checkout', id: 'cust-1' });
    expect(decision).toEqual({ experimentId: 10, ...CONTROL, enrolled: false, reason: 'wrong-id-kind' });
  });

  test('a customer-id experiment refuses a visitor ID: wrong-id-kind', async () => {
    const byCustomer = experiment({ bucketOn: 'customer_id' });
    const decision = await decide({
      config: config([byCustomer]),
      salt: SALT,
      key: 'new-checkout',
      visitorId: VISITOR,
    });
    expect(decision).toEqual({ experimentId: 10, ...CONTROL, enrolled: false, reason: 'wrong-id-kind' });
  });

  test('a customer-id experiment enrols as the derived enrolment ID', async () => {
    const byCustomer = experiment({ bucketOn: 'customer_id' });
    const decision = await decide({
      config: config([byCustomer]),
      salt: SALT,
      key: 'new-checkout',
      visitorId: VISITOR,
      id: 'Cust-1',
    });
    expect(decision).toEqual({
      experimentId: 10,
      variantId: 102,
      variantKey: 'treatment',
      payload: { color: 'green' },
      enrolled: true,
      enrolAs: await deriveEnrolmentId({ salt: SALT, customerId: 'Cust-1' }),
    });
  });

  test('a customer ID is case-sensitive and buckets on its enrolment ID, not the raw ID', async () => {
    const split = experiment({
      bucketOn: 'customer_id',
      variants: [
        { id: 101, key: 'control', weight: 5000, payload: null },
        { id: 102, key: 'treatment', weight: 5000, payload: null },
      ],
    });
    const enrolAsFor: Record<string, string> = {};
    for (const id of ['Cust-1', 'cust-1', 'customer-42', 'Kund-ÅÄÖ', 'a', 'b', 'c', 'd']) {
      const decision = await decide({ config: config([split]), salt: SALT, key: 'new-checkout', id });
      if (!decision.enrolled || decision.enrolAs === undefined) throw new Error(`expected an enrolment for ${id}`);
      expect(decision.enrolAs).toBe(await deriveEnrolmentId({ salt: SALT, customerId: id }));
      const bucket = await bucketFor({ salt: SALT, experimentId: 10, id: decision.enrolAs });
      expect(decision.variantId).toBe(bucket < 5000 ? 101 : 102);
      enrolAsFor[id] = decision.enrolAs;
    }
    expect(enrolAsFor['Cust-1']).not.toBe(enrolAsFor['cust-1']);
  });

  test('a visitor experiment never sets enrolAs, even when a customer ID is also given', async () => {
    const decision = await decide({
      config: config([experiment({})]),
      salt: SALT,
      key: 'new-checkout',
      visitorId: VISITOR,
      id: 'cust-1',
    });
    expect(decision.enrolled).toBe(true);
    expect('enrolAs' in decision).toBe(false);
  });

  test('a targeting miss: control, targeting', async () => {
    const targeted = experiment({ targeting: [{ attribute: 'plan', operator: 'equals', value: 'pro' }] });
    const miss = await decide({
      config: config([targeted]),
      salt: SALT,
      key: 'new-checkout',
      visitorId: VISITOR,
      attributes: { plan: 'free' },
    });
    expect(miss).toEqual({ experimentId: 10, ...CONTROL, enrolled: false, reason: 'targeting' });
    const hit = await decide({
      config: config([targeted]),
      salt: SALT,
      key: 'new-checkout',
      visitorId: VISITOR,
      attributes: { plan: 'pro' },
    });
    expect(hit.enrolled).toBe(true);
  });

  test('the ID check comes before targeting', async () => {
    const targeted = experiment({ targeting: [{ attribute: 'plan', operator: 'exists' }] });
    const decision = await decide({ config: config([targeted]), salt: SALT, key: 'new-checkout' });
    expect(decision.enrolled === false && decision.reason).toBe('no-id');
  });

  test('no weight anywhere: control, not-running', async () => {
    const empty = experiment({
      variants: [
        { id: 101, key: 'control', weight: 0, payload: null },
        { id: 102, key: 'treatment', weight: 0, payload: null },
      ],
    });
    const decision = await decide({ config: config([empty]), salt: SALT, key: 'new-checkout', visitorId: VISITOR });
    expect(decision).toEqual({
      experimentId: 10,
      variantId: 101,
      variantKey: 'control',
      payload: null,
      enrolled: false,
      reason: 'not-running',
    });
  });

  test('no variants at all: null variant, not-running', async () => {
    const decision = await decide({
      config: config([experiment({ variants: [] })]),
      salt: SALT,
      key: 'new-checkout',
      visitorId: VISITOR,
    });
    expect(decision).toEqual({
      experimentId: 10,
      variantId: null,
      variantKey: null,
      payload: null,
      enrolled: false,
      reason: 'not-running',
    });
  });

  test('a malformed config is unknown-key, not a throw', async () => {
    const broken = { version: 1 } as unknown as SdkConfig;
    const decision = await decide({ config: broken, salt: SALT, key: 'new-checkout', visitorId: VISITOR });
    expect(decision.enrolled === false && decision.reason).toBe('unknown-key');
  });
});

describe('decideAll', () => {
  test('decides every experiment, keyed by flag key, first key wins on a duplicate', async () => {
    const decisions = await decideAll({
      config: config([
        experiment({}),
        experiment({ id: 11, key: 'banner', bucketOn: 'customer_id' }),
        experiment({ id: 12, key: 'banner' }),
      ]),
      salt: SALT,
      visitorId: VISITOR,
    });
    expect(Object.keys(decisions)).toEqual(['new-checkout', 'banner']);
    expect(decisions['new-checkout']?.enrolled).toBe(true);
    expect(decisions['banner']).toMatchObject({ experimentId: 11, enrolled: false, reason: 'wrong-id-kind' });
  });
});

describe('variantMapFor', () => {
  const experiments = [
    experiment({ id: 10, key: 'by-visitor' }),
    experiment({ id: 11, key: 'by-customer', bucketOn: 'customer_id' }),
    experiment({ id: 12, key: 'targeted', targeting: [{ attribute: 'plan', operator: 'equals', value: 'pro' }] }),
    experiment({ id: 13, key: 'deployed', status: 'Deployed', deployedVariantId: 102 }),
  ];

  test('a visitor ID maps the Running visitor experiments it is enrolled in', async () => {
    const map = await variantMapFor({ config: config(experiments), salt: SALT, visitorId: VISITOR });
    expect(map).toEqual({ '10': '102' });
  });

  test('a customer ID maps only customer-id experiments', async () => {
    const map = await variantMapFor({ config: config(experiments), salt: SALT, id: 'cust-1' });
    expect(map).toEqual({ '11': '102' });
  });

  test('attributes let targeted experiments in; both IDs map both kinds', async () => {
    const map = await variantMapFor({
      config: config(experiments),
      salt: SALT,
      visitorId: VISITOR,
      id: 'cust-1',
      attributes: { plan: 'pro' },
    });
    expect(map).toEqual({ '10': '102', '11': '102', '12': '102' });
  });

  test('no ID or no experiments is an empty map', async () => {
    expect(await variantMapFor({ config: config(experiments), salt: SALT })).toEqual({});
    expect(await variantMapFor({ config: config([]), salt: SALT, visitorId: VISITOR })).toEqual({});
  });

  test('only decimal integer IDs make it into the map', async () => {
    const odd = [experiment({ id: 1.5, key: 'fraction' }), experiment({ id: 14, key: 'ok' })];
    const map = await variantMapFor({ config: config(odd), salt: SALT, visitorId: VISITOR });
    expect(map).toEqual({ '14': '102' });
  });
});
