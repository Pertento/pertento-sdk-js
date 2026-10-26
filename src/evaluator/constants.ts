/** Constants the evaluator shares with the Pertento tracking server; both must agree. */

/**
 * The newest `SdkConfig.version` this evaluator understands. 2 added rollouts (feature flags): a
 * version 1 reader would ignore `rollout` and split a flag by its stored weights instead.
 */
export const SDK_CONFIG_VERSION = 2;

/**
 * Every `SdkConfig.version` a reader accepts; every version check uses this list. Version 1 is
 * version 2 without any rollout and decides the same, so it stays accepted.
 */
export const SUPPORTED_CONFIG_VERSIONS = [1, 2] as const;

/** What a config with no rollout is written as, so SDKs that only know version 1 keep reading it. */
export const CONFIG_VERSION_WITHOUT_ROLLOUTS = 1;

/** Buckets per experiment. Variant weights are basis points of this total. */
export const BUCKET_COUNT = 10000;

/** Operators an attribute rule may use. Semantics are in spec/SPEC.md. */
export const ATTRIBUTE_RULE_OPERATORS = ['equals', 'in', 'not in', '<', '>', 'exists'] as const;

/** What a server-decided experiment hashes on. */
export const EXPERIMENT_BUCKET_ON = ['visitor', 'customer_id'] as const;

/** A website's conversion reporter. 'server': only the customer's backend reports. */
export const TRACKING_METHODS = ['ga4', 'matomo', 'pertento', 'server'] as const;

/** Why a decision is not an enrolment. Every `enrolled: false` carries one. */
export const DECISION_REASONS = ['no-id', 'wrong-id-kind', 'not-running', 'targeting', 'unknown-key', 'ring'] as const;
