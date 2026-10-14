import type { DecideIdentity, Decision, SdkConfig } from './types';
import { describe, expect, test } from 'bun:test';
import rawVectors from '../../spec/vectors.json';
import { bucketFor } from './bucket';
import { DECISION_REASONS, SDK_CONFIG_VERSION } from './constants';
import { decide, variantMapFor } from './decide';
import { deriveEnrolmentId } from './enrolment-id';

type VectorFile = {
  specVersion: number;
  buckets: Array<{ salt: string; experimentId: number; id: string; message: string; bucket: number }>;
  enrolmentIds: Array<{ salt: string; customerId: string; enrolmentId: string }>;
  decisionSalt: string;
  decisionConfig: SdkConfig;
  decisions: Array<{ name: string; input: DecideIdentity & { key: string }; expected: Decision }>;
  variantMaps: Array<{ name: string; input: DecideIdentity; expected: Record<string, string> }>;
};

// JSON imports infer `string` where the types want literals; the file is ours and committed.
const vectors = rawVectors as unknown as VectorFile;

describe('spec/vectors.json', () => {
  test('is for this spec version and covers every reason', () => {
    expect(vectors.specVersion).toBe(SDK_CONFIG_VERSION);
    const reasons = new Set(vectors.decisions.flatMap(({ expected }) => (expected.enrolled ? [] : [expected.reason])));
    expect([...reasons].sort()).toEqual([...DECISION_REASONS].sort());
    expect(vectors.decisions.some(({ expected }) => expected.enrolled && expected.enrolAs)).toBe(true);
  });

  test.each(vectors.buckets)('bucket $experimentId:$id', async ({ salt, experimentId, id, message, bucket }) => {
    expect(`${experimentId}:${id.toLowerCase()}`).toBe(message);
    expect(await bucketFor({ salt, experimentId, id })).toBe(bucket);
  });

  test.each(vectors.enrolmentIds)('enrolment ID for $customerId', async ({ salt, customerId, enrolmentId }) => {
    expect(await deriveEnrolmentId({ salt, customerId })).toBe(enrolmentId);
  });

  test.each(vectors.decisions)('decision: $name', async ({ input, expected }) => {
    expect(await decide({ config: vectors.decisionConfig, salt: vectors.decisionSalt, ...input })).toEqual(expected);
    // A customer-id enrolment buckets on its enrolment ID, which is derived from the raw ID.
    if (expected.enrolled && expected.enrolAs !== undefined && input.id !== undefined) {
      expect(expected.enrolAs).toBe(await deriveEnrolmentId({ salt: vectors.decisionSalt, customerId: input.id }));
    }
  });

  test.each(vectors.variantMaps)('variant map: $name', async ({ input, expected }) => {
    expect(await variantMapFor({ config: vectors.decisionConfig, salt: vectors.decisionSalt, ...input })).toEqual(
      expected,
    );
  });
});
