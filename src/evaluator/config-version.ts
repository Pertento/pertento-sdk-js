import type { SdkConfigVersion, SdkExperiment } from './types';
import { CONFIG_VERSION_WITHOUT_ROLLOUTS, SDK_CONFIG_VERSION, SUPPORTED_CONFIG_VERSIONS } from './constants';
import { hasRollout } from './rollout';
import { isObject } from './weights';

/**
 * The version a writer stamps on a config: 2 only when some experiment has a rollout, else 1.
 * A config without flags stays readable by SDKs that only know version 1, which decide it
 * exactly as a version 2 reader does (spec/SPEC.md, "Config").
 */
export function configVersionFor(experiments: readonly SdkExperiment[]): SdkConfigVersion {
  if (!Array.isArray(experiments)) return CONFIG_VERSION_WITHOUT_ROLLOUTS;
  return experiments.some((experiment) => isObject(experiment) && hasRollout(experiment))
    ? SDK_CONFIG_VERSION
    : CONFIG_VERSION_WITHOUT_ROLLOUTS;
}

/** Whether a reader of this evaluator accepts a config of this version. */
export const isSupportedConfigVersion = (version: unknown): version is SdkConfigVersion =>
  (SUPPORTED_CONFIG_VERSIONS as readonly unknown[]).includes(version);
