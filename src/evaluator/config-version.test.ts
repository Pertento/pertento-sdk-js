import type { SdkExperiment } from './types';
import { describe, expect, test } from 'bun:test';
import { configVersionFor, isSupportedConfigVersion } from './config-version';
import { CONFIG_VERSION_WITHOUT_ROLLOUTS, SDK_CONFIG_VERSION, SUPPORTED_CONFIG_VERSIONS } from './constants';

const experiment = (overrides: Partial<SdkExperiment> = {}): SdkExperiment => ({
  id: 1,
  key: 'k',
  status: 'Running',
  bucketOn: 'visitor',
  variants: [],
  deployedVariantId: null,
  targeting: [],
  ...overrides,
});

const rollout = { onVariantId: 2, rolloutBp: 0, holdbackBp: 0, rings: [] };

describe('configVersionFor', () => {
  test('a config without rollouts is version 1', () => {
    expect(configVersionFor([])).toBe(1);
    expect(configVersionFor([experiment(), experiment({ id: 2, key: 'j' })])).toBe(1);
    expect(CONFIG_VERSION_WITHOUT_ROLLOUTS).toBe(1);
  });

  test('a rollout: null is no rollout', () => {
    const nullRollout = { ...experiment(), rollout: null } as unknown as SdkExperiment;
    expect(configVersionFor([nullRollout])).toBe(1);
  });

  test('any experiment with a rollout makes it the newest version, 2', () => {
    expect(configVersionFor([experiment(), experiment({ id: 2, key: 'flag', rollout })])).toBe(2);
    expect(SDK_CONFIG_VERSION).toBe(2);
  });

  test('a malformed rollout still counts: a version 1 reader must not split it by weight', () => {
    const odd = { ...experiment(), rollout: 'full' } as unknown as SdkExperiment;
    expect(configVersionFor([odd])).toBe(2);
  });

  test('entries that are not objects, or a list that is not one, never throw', () => {
    expect(configVersionFor([null, 'x', 3] as unknown as SdkExperiment[])).toBe(1);
    expect(configVersionFor(undefined as unknown as SdkExperiment[])).toBe(1);
  });
});

describe('isSupportedConfigVersion', () => {
  test('accepts 1 and 2, nothing else', () => {
    expect([...SUPPORTED_CONFIG_VERSIONS]).toEqual([1, 2]);
    for (const version of [1, 2]) expect(isSupportedConfigVersion(version)).toBe(true);
    for (const version of [0, 3, '1', '2', 1.5, null, undefined]) expect(isSupportedConfigVersion(version)).toBe(false);
  });
});
