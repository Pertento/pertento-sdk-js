import type { DecideIdentity, Decision, SdkConfig, SdkVariant } from './types';
import { describe, expect, test } from 'bun:test';
import rawVectors from '../../spec/vectors.json';
import { bucketFor } from './bucket';
import { configVersionFor } from './config-version';
import { DECISION_REASONS, SDK_CONFIG_VERSION } from './constants';
import { decide, variantMapFor } from './decide';
import { deriveEnrolmentId } from './enrolment-id';
import { pickByBucket } from './weights';

type VectorFile = {
  specVersion: number;
  buckets: Array<{ salt: string; experimentId: number; id: string; message: string; bucket: number }>;
  enrolmentIds: Array<{ salt: string; customerId: string; enrolmentId: string }>;
  weightWalks: Array<{ name: string; variants: SdkVariant[]; bucket: number; expected: number | null }>;
  decisionSalt: string;
  decisionConfig: SdkConfig;
  decisions: Array<{ name: string; input: DecideIdentity & { key: string }; expected: Decision }>;
  variantMaps: Array<{ name: string; input: DecideIdentity; expected: Record<string, string> }>;
  rolloutConfig: SdkConfig;
  rolloutDecisions: Array<{
    name: string;
    input: DecideIdentity & { key: string };
    bucket: number | null;
    expected: Decision;
  }>;
  rolloutVariantMaps: Array<{ name: string; input: DecideIdentity; expected: Record<string, string> }>;
};

// JSON imports infer `string` where the types want literals; the file is ours and committed.
const vectors = rawVectors as unknown as VectorFile;

describe('spec/vectors.json', () => {
  test('is for this spec version and covers every reason', () => {
    expect(vectors.specVersion).toBe(SDK_CONFIG_VERSION);
    // A writer stamps 1 unless a rollout is present: the plain config stays readable by version 1 SDKs.
    expect(vectors.decisionConfig.version).toBe(1);
    expect(configVersionFor(vectors.decisionConfig.experiments)).toBe(1);
    expect(vectors.rolloutConfig.version).toBe(2);
    expect(configVersionFor(vectors.rolloutConfig.experiments)).toBe(2);
    const reasons = new Set(
      [...vectors.decisions, ...vectors.rolloutDecisions].flatMap(({ expected }) =>
        expected.enrolled ? [] : [expected.reason],
      ),
    );
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

  test.each(vectors.weightWalks)('weight walk: $name at $bucket', ({ variants, bucket, expected }) => {
    expect(pickByBucket(variants, bucket)?.id ?? null).toBe(expected);
  });

  test('every decision vector has a distinct name', () => {
    const names = [...vectors.decisions, ...vectors.rolloutDecisions].map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
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

  test.each(vectors.rolloutDecisions)('rollout decision: $name', async ({ input, bucket, expected }) => {
    expect(await decide({ config: vectors.rolloutConfig, salt: vectors.decisionSalt, ...input })).toEqual(expected);
    // `bucket` is there to tell a bucketing bug from a rollout bug: an enrolled decision was made at it.
    if (!expected.enrolled) {
      expect(bucket).toBeNull();
      return;
    }
    const id = expected.enrolAs ?? input.visitorId ?? '';
    expect(bucket).toBe(await bucketFor({ salt: vectors.decisionSalt, experimentId: expected.experimentId, id }));
  });

  test.each(vectors.rolloutVariantMaps)('rollout variant map: $name', async ({ input, expected }) => {
    expect(await variantMapFor({ config: vectors.rolloutConfig, salt: vectors.decisionSalt, ...input })).toEqual(
      expected,
    );
  });
});
