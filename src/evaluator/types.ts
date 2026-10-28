import type {
  ATTRIBUTE_RULE_OPERATORS,
  DECISION_REASONS,
  EXPERIMENT_BUCKET_ON,
  SUPPORTED_CONFIG_VERSIONS,
  TRACKING_METHODS,
} from './constants';

export type AttributeRuleOperator = (typeof ATTRIBUTE_RULE_OPERATORS)[number];
export type BucketOn = (typeof EXPERIMENT_BUCKET_ON)[number];
export type TrackingMethod = (typeof TRACKING_METHODS)[number];
export type DecisionReason = (typeof DECISION_REASONS)[number];
export type SdkConfigVersion = (typeof SUPPORTED_CONFIG_VERSIONS)[number];

/** One attribute rule. `value` is absent for 'exists'. */
export type AttributeRule = {
  attribute: string;
  operator: AttributeRuleOperator;
  value?: string | number | boolean | Array<string | number>;
};

/** What the caller knows about the visitor. Untrusted: matched, never trusted as typed. */
export type Attributes = Readonly<Record<string, unknown>>;

export type SdkVariant = {
  id: number;
  key: string;
  /** Basis points; see spec/SPEC.md for how a total other than 10000 is handled. */
  weight: number;
  payload: unknown;
};

/**
 * A ring: people who get one side of a flag by rule rather than by bucket. It matches when
 * every rule matches the attributes and, when `ids` is set, the person's ID is in it.
 */
export type SdkRing = {
  rules: AttributeRule[];
  ids?: string[];
  serve: 'on' | 'off';
};

/**
 * Makes an experiment a feature flag decided by sticky rollout instead of the weight walk:
 * On when the bucket is below min(rolloutBp, 10000 - holdbackBp). See spec/SPEC.md, "Rollouts".
 */
export type SdkRollout = {
  /** The On variant. Off is the experiment's other variant. */
  onVariantId: number;
  /** Basis points of buckets that are On, 0..10000. Raising it only adds people. */
  rolloutBp: number;
  /** Basis points at the top of the bucket range that are always Off, 0..10000. */
  holdbackBp: number;
  /** Evaluated in order before the bucket; the first that matches decides. */
  rings: SdkRing[];
};

export type SdkExperiment = {
  id: number;
  /** The flag key the customer's code asks for. */
  key: string;
  status: 'Running' | 'Deployed';
  bucketOn: BucketOn;
  /** Sorted by id ascending by the writer; the evaluator sorts again defensively. */
  variants: SdkVariant[];
  deployedVariantId: number | null;
  targeting: AttributeRule[];
  /** Present only on a feature flag (exactly two variants, Off and On). */
  rollout?: SdkRollout;
};

export type SdkConfig = {
  /** 1 unless an experiment has a rollout (configVersionFor). */
  version: SdkConfigVersion;
  websiteId: number;
  generatedAt: number;
  trackingMethod: TrackingMethod | null;
  experiments: SdkExperiment[];
};

/** The identity and context a decision is made for. */
export type DecideIdentity = {
  /** The browser's visitor ID (a UUID). Hashed by 'visitor' experiments. */
  visitorId?: string;
  /** The customer's own ID for the person. Hashed by 'customer_id' experiments. */
  id?: string;
  attributes?: Attributes;
};

export type DecideInput = DecideIdentity & {
  config: Readonly<SdkConfig>;
  /** The website's secret salt, as given in the config response. */
  salt: string;
  /** The experiment's flag key. */
  key: string;
};

export type EnrolledDecision = {
  experimentId: number;
  variantId: number;
  variantKey: string;
  payload: unknown;
  enrolled: true;
  /** The derived enrolment ID; set only for 'customer_id' experiments. */
  enrolAs?: string;
};

export type NotEnrolledDecision = {
  /** null only for 'unknown-key'. */
  experimentId: number | null;
  /** null for 'unknown-key', and for an experiment with no variants. */
  variantId: number | null;
  variantKey: string | null;
  payload: unknown;
  enrolled: false;
  reason: DecisionReason;
};

export type Decision = EnrolledDecision | NotEnrolledDecision;

export type SeedAssignment = { variantId: string; enrolAs?: string };

/** What the page receives as `window.PertentoSeed`. Keys are experiment IDs as decimal strings. */
export type Seed = {
  visitorId?: string;
  assignments: Record<string, SeedAssignment>;
};
