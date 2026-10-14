/**
 * Duplicated from `definitions` on purpose, not imported: the SDK bundle inlines this
 * package and must not pull the whole definitions package in with it. A later PR
 * (the tracking server's /sdk work) adds a test asserting the two copies agree.
 */

/** The `SdkConfig.version` this evaluator understands. */
export const SDK_CONFIG_VERSION = 1;

/** Buckets per experiment. Variant weights are basis points of this total. */
export const BUCKET_COUNT = 10000;

/** Operators an attribute rule may use. Semantics are in spec/SPEC.md. */
export const ATTRIBUTE_RULE_OPERATORS = ['equals', 'in', 'not in', '<', '>', 'exists'] as const;

/** What a server-decided experiment hashes on. */
export const EXPERIMENT_BUCKET_ON = ['visitor', 'customer_id'] as const;

/** A website's conversion reporter. 'server': only the customer's backend reports. */
export const TRACKING_METHODS = ['ga4', 'matomo', 'pertento', 'server'] as const;

/** Why a decision is not an enrolment. Every `enrolled: false` carries one. */
export const DECISION_REASONS = ['no-id', 'wrong-id-kind', 'not-running', 'targeting', 'unknown-key'] as const;
