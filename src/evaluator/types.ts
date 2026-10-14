import type {
  ATTRIBUTE_RULE_OPERATORS,
  DECISION_REASONS,
  EXPERIMENT_BUCKET_ON,
  SDK_CONFIG_VERSION,
  TRACKING_METHODS,
} from './constants';

export type AttributeRuleOperator = (typeof ATTRIBUTE_RULE_OPERATORS)[number];
export type BucketOn = (typeof EXPERIMENT_BUCKET_ON)[number];
export type TrackingMethod = (typeof TRACKING_METHODS)[number];
export type DecisionReason = (typeof DECISION_REASONS)[number];

/** Same shape as `AttributeRule` in pertentodb/types. `value` is absent for 'exists'. */
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
};

export type SdkConfig = {
  version: typeof SDK_CONFIG_VERSION;
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
