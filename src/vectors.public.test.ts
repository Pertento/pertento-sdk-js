import type { DecideIdentity, Decision, SdkConfig } from './evaluator';
import { describe, expect, test } from 'bun:test';
import rawVectors from '../spec/vectors.json';
import { fakeFetch } from '../test/fake-fetch';
import { createPertento } from './index';

type VectorFile = {
  decisionSalt: string;
  decisionConfig: SdkConfig;
  decisions: Array<{ name: string; input: DecideIdentity & { key: string }; expected: Decision }>;
};
const vectors = rawVectors as unknown as VectorFile;

// `weightWalks` are not run here: the weight walk is internal to the evaluator and the public
// API cannot hand it a bucket, so src/evaluator/vectors.test.ts runs them directly. Every
// decision vector runs below, including the all-zero-weights and no-variants cases.

describe('spec/vectors.json through the public API', async () => {
  const { fetch } = fakeFetch({
    status: 200,
    body: { ...vectors.decisionConfig, salt: vectors.decisionSalt },
    headers: { etag: '"vectors"' },
  });
  const pertento = createPertento({ websiteId: vectors.decisionConfig.websiteId, serverKey: 'psk_live_x', fetch, background: false });
  await pertento.ready();

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
