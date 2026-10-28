import type { DecideIdentity, Decision, SdkConfig } from './evaluator';
import { describe, expect, test } from 'bun:test';
import rawVectors from '../spec/vectors.json';
import { fakeFetch } from '../test/fake-fetch';
import { createPertento } from './index';

type DecisionVector = { name: string; input: DecideIdentity & { key: string }; expected: Decision };

type VectorFile = {
  decisionSalt: string;
  decisionConfig: SdkConfig;
  decisions: DecisionVector[];
  rolloutConfig: SdkConfig;
  rolloutDecisions: DecisionVector[];
};
const vectors = rawVectors as unknown as VectorFile;

// `weightWalks` are not run here: the weight walk is internal to the evaluator and the public
// API cannot hand it a bucket, so src/evaluator/vectors.test.ts runs them directly. Every
// decision vector runs below, including the all-zero-weights and no-variants cases, and every
// rollout vector against the version 2 config that carries the feature flags.

async function clientFor(config: SdkConfig) {
  const { fetch } = fakeFetch({
    status: 200,
    body: { ...config, salt: vectors.decisionSalt },
    headers: { etag: '"vectors"' },
  });
  const pertento = createPertento({ websiteId: config.websiteId, serverKey: 'psk_live_test_00000000000000000000000000000000000000', fetch, background: false });
  await pertento.ready();
  return pertento;
}

describe('spec/vectors.json through the public API', async () => {
  const pertento = await clientFor(vectors.decisionConfig);

  test.each(vectors.decisions)('getVariant: $name', async ({ input: { key, ...identity }, expected }) => {
    expect(await pertento.getVariant(key, identity)).toStrictEqual(expected);
  });

  test('getAll agrees with getVariant for every key', async () => {
    const identity = { visitorId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', id: 'customer-42' };
    const all = await pertento.getAll(identity);
    expect(Object.keys(all).sort()).toEqual(vectors.decisionConfig.experiments.map(({ key }) => key).sort());
    for (const [key, decision] of Object.entries(all)) {
      expect(decision).toEqual(await pertento.getVariant(key, identity));
    }
  });
});

describe('spec/vectors.json rollouts through the public API', async () => {
  const pertento = await clientFor(vectors.rolloutConfig);

  test('the rollout config is version 2, and accepted', () => {
    expect(vectors.rolloutConfig.version).toBe(2);
    expect(pertento.lastError).toBeNull();
  });

  test.each(vectors.rolloutDecisions)('getVariant: $name', async ({ input: { key, ...identity }, expected }) => {
    expect(await pertento.getVariant(key, identity)).toStrictEqual(expected);
  });

  test('getAll agrees with getVariant for every flag', async () => {
    const identity = { visitorId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', id: 'Cust-1', attributes: { plan: 'pro' } };
    const all = await pertento.getAll(identity);
    expect(Object.keys(all).sort()).toEqual(vectors.rolloutConfig.experiments.map(({ key }) => key).sort());
    for (const [key, decision] of Object.entries(all)) {
      expect(decision).toEqual(await pertento.getVariant(key, identity));
    }
  });
});
