import type { DecideIdentity, Decision, SdkConfig } from './evaluator';
import type { ErrorReporter, PertentoErrorKind } from './errors';
import type { FetchLike, FetchResponse } from './http';
import { deriveEnrolmentId, isUuid } from './evaluator';
import { kindForStatus, serverMessage, thrownFetchError, timedFetch } from './http';

/** The most exposures one request carries. A queue this long is sent at once. */
export const MAX_EXPOSURES_PER_REQUEST = 100;
/** How long an exposure waits in the queue before the background timer sends it. */
export const EXPOSURE_FLUSH_INTERVAL_MS = 2_000;
/** How long one exposure request waits for the server. It never retries. */
export const EXPOSURE_TIMEOUT_MS = 2_000;
/** How many experiment and enrolment ID pairs a client remembers as reported. */
export const REPORTED_EXPOSURES_LIMIT = 10_000;

/** One enrolled decision, or one served from a Deployed experiment, as `POST /sdk/exposures` takes it. */
export type Exposure = { experimentId: number; variantId: number; enrolAs: string };

export type ExposureReporter = {
  /**
   * Queues the decisions that count which this client has not reported yet: the enrolled ones,
   * and those `deployedIds` gives an enrolment ID (see `deployedEnrolmentIds`). `visitorId` is
   * the cleaned visitor ID they were decided for. Only touches memory: a send it starts is not
   * awaited.
   */
  record: (
    decisions: readonly Decision[],
    visitorId: string | undefined,
    deployedIds?: ReadonlyMap<Decision, string>,
  ) => void;
  /**
   * A page seeded with these decisions enrols them itself, so they are taken out of the queue
   * and never queued again. `visitorId` is the cleaned visitor ID the seed carries.
   */
  seeded: (decisions: readonly Decision[], visitorId: string | undefined) => void;
  /** Called at the start of every `getVariant`, `getAll` and `track`: sends the queue when no timer will. */
  onCall: () => void;
  /** Sends what is queued and resolves when every send in flight has finished. Never rejects. */
  flush: () => Promise<void>;
  /** Flushes and stops the timer. Later exposures wait for the next call or `flush()`. Never rejects. */
  close: () => Promise<void>;
};

export type CreateExposureReporterParams = {
  baseUrl: string;
  serverKey: string;
  fetch: FetchLike;
  errors: ErrorReporter;
  /** Send on a timer. Off for request-scoped runtimes, where the next call sends instead. */
  background: boolean;
  /** `false` records and sends nothing. */
  enabled: boolean;
  flushIntervalMs?: number;
  requestTimeoutMs?: number;
  reportedLimit?: number;
};

/**
 * The enrolment ID the server counts a decision under, or undefined when it does not count. For
 * an enrolled decision, the derived one for a customer ID experiment, else the visitor ID; for a
 * decision served from a Deployed experiment, the one `deployedIds` gives it.
 */
const enrolmentIdOf = (
  decision: Decision,
  visitorId: string | undefined,
  deployedIds?: ReadonlyMap<Decision, string>,
): string | undefined => {
  const id = decision.enrolled ? (decision.enrolAs ?? visitorId) : deployedIds?.get(decision);
  return isUuid(id) ? id.toLowerCase() : undefined;
};

const isPositiveId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

const exposureKey = (experimentId: number, enrolAs: string): string => `${experimentId}:${enrolAs}`;

export type DeployedEnrolmentIdsParams = {
  decisions: readonly Decision[];
  config: Readonly<SdkConfig>;
  salt: string;
  /** The cleaned identity the decisions were made for. */
  identity: DecideIdentity;
};

/**
 * The enrolment ID each decision served from a Deployed experiment is reported under, keyed by
 * the decision. Such a decision is not enrolled, but the server bills it as a deployed variant's
 * session, as it does a visit to a page showing the deployed variant.
 *
 * A decision gets one when its experiment is Deployed and it is the deployed variant: the visitor
 * ID for a visitor experiment, or for a customer ID experiment the ID derived from `identity.id`
 * as the server derives it (a decision that is not enrolled carries no `enrolAs`). One with no ID
 * of its experiment's kind gets none. Rejects only when Web Crypto fails.
 */
export async function deployedEnrolmentIds({
  decisions,
  config,
  salt,
  identity,
}: DeployedEnrolmentIdsParams): Promise<Map<Decision, string>> {
  const ids = new Map<Decision, string>();
  const experiments = Array.isArray(config?.experiments) ? config.experiments : [];
  // One customer ID derives one enrolment ID, whatever the experiment.
  let derived: Promise<string> | undefined;
  for (const decision of decisions) {
    if (decision === null || typeof decision !== 'object' || decision.enrolled) continue;
    const experiment = experiments.find(
      (candidate) => candidate !== null && typeof candidate === 'object' && candidate.id === decision.experimentId,
    );
    if (experiment?.status !== 'Deployed') continue;
    if (!isPositiveId(decision.variantId) || decision.variantId !== experiment.deployedVariantId) continue;
    let id: string | undefined;
    if (experiment.bucketOn === 'visitor') id = identity.visitorId;
    else if (experiment.bucketOn === 'customer_id' && typeof identity.id === 'string' && identity.id.length > 0) {
      derived ??= deriveEnrolmentId({ salt, customerId: identity.id });
      id = await derived;
    }
    if (isUuid(id)) ids.set(decision, id.toLowerCase());
  }
  return ids;
}

/**
 * A set that holds at most `limit` keys. Adding one more forgets the key seen longest ago,
 * so a long-running process remembers recent visitors without its memory growing.
 */
function boundedSet(limit: number): { has: (key: string) => boolean; add: (key: string) => void } {
  const keys = new Set<string>();
  return {
    has: (key) => keys.has(key),
    add: (key) => {
      // Re-adding moves the key to the newest end, so a visitor seen often is the last forgotten.
      keys.delete(key);
      keys.add(key);
      if (keys.size <= limit) return;
      const oldest = keys.values().next();
      if (!oldest.done) keys.delete(oldest.value);
    },
  };
}

/**
 * Reports the enrolled decisions this client makes to `POST /sdk/exposures`, so a flag decided
 * only on the server enrols its visitors as the browser's snippet would. Decisions served from a
 * Deployed experiment are reported too, and count as a deployed variant's sessions.
 *
 * - Each experiment and enrolment ID pair is sent once per client. The server dedupes too; this
 *   saves requests, it is not what keeps the counts right.
 * - Exposures are batched: in the background a timer sends them within 2 s, unref'd so it never
 *   keeps a Node process alive; without one, the next `getVariant`, `getAll` or `track` sends
 *   them. 100 queued are sent at once either way.
 * - At most once: one attempt, a 2 s timeout, no retry. A batch that fails is dropped and
 *   reported with source `exposures`, logged once per kind. Nothing here throws, and no
 *   decision waits for a send.
 * - Decisions put in a page seed are never sent: the browser enrols those. That only saves a
 *   request; the server counts a person once whichever side reports them first. A seed carries
 *   only enrolled decisions, so a deployed one is reported whether the page is seeded or not.
 */
export function createExposureReporter(params: CreateExposureReporterParams): ExposureReporter {
  const { baseUrl, serverKey, fetch, errors, background, enabled } = params;
  const flushIntervalMs = params.flushIntervalMs ?? EXPOSURE_FLUSH_INTERVAL_MS;
  const requestTimeoutMs = params.requestTimeoutMs ?? EXPOSURE_TIMEOUT_MS;

  /** Waiting to be sent, keyed by exposureKey, in the order they were decided. */
  const queue = new Map<string, Exposure>();
  /** Queued or sent already, or enrolled by a page seed: never queued again. */
  const reported = boundedSet(params.reportedLimit ?? REPORTED_EXPOSURES_LIMIT);
  /** The exposure key each returned decision was recorded under, for `seeded`. */
  const keyOfDecision = new WeakMap<object, string>();
  const inFlight = new Set<Promise<void>>();
  let timer: unknown = null;
  let timersOn = background;

  const report = (kind: PertentoErrorKind, message: string, status?: number): void => {
    errors.report(
      status === undefined ? { source: 'exposures', kind, message } : { source: 'exposures', kind, message, status },
    );
  };

  const post = async (batch: readonly Exposure[]): Promise<void> => {
    const dropped = `${batch.length} exposure${batch.length === 1 ? '' : 's'} dropped (not retried)`;
    let response: FetchResponse;
    try {
      response = await timedFetch({
        fetch,
        url: `${baseUrl}/sdk/exposures`,
        init: {
          method: 'POST',
          headers: {
            authorization: `Bearer ${serverKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ exposures: batch }),
        },
        timeoutMs: requestTimeoutMs,
      });
    } catch (error) {
      const { kind, message } = thrownFetchError(error, requestTimeoutMs);
      report(kind, `${dropped}: ${message}`);
      return;
    }
    if (response.status === 200) {
      errors.clear('exposures');
      return;
    }
    const message = await serverMessage(response);
    report(kindForStatus(response.status), `${dropped}, refused: ${message}`, response.status);
  };

  /** A bug guard: reporting must never throw into a decision. Expected failures are handled where they happen. */
  const unexpected = (error: unknown): void => {
    report('network', error instanceof Error ? error.message : String(error));
  };

  const send = (batch: readonly Exposure[]): void => {
    const sending: Promise<void> = post(batch)
      .catch(unexpected)
      .finally(() => inFlight.delete(sending));
    inFlight.add(sending);
  };

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer as number);
    timer = null;
  };

  /** Sends the whole queue, in batches of at most 100, without waiting. Never throws. */
  const sendQueue = (): void => {
    try {
      clearTimer();
      if (queue.size === 0) return;
      const pending = [...queue.values()];
      queue.clear();
      for (let start = 0; start < pending.length; start += MAX_EXPOSURES_PER_REQUEST) {
        send(pending.slice(start, start + MAX_EXPOSURES_PER_REQUEST));
      }
    } catch (error) {
      unexpected(error);
    }
  };

  const armTimer = (): void => {
    if (!timersOn || timer !== null) return;
    try {
      const handle: unknown = setTimeout(() => {
        timer = null;
        sendQueue();
      }, flushIntervalMs);
      timer = handle;
      // Node and Bun return a Timeout object; unref() lets the process exit while it is pending.
      const unref = typeof handle === 'object' && handle !== null ? (handle as { unref?: unknown }).unref : undefined;
      if (typeof unref === 'function') unref.call(handle);
    } catch {
      // A runtime that forbids timers here sends on the next call instead.
      timersOn = false;
    }
  };

  const queueDecisions = (
    decisions: readonly Decision[],
    visitorId: string | undefined,
    deployedIds?: ReadonlyMap<Decision, string>,
  ): void => {
    for (const decision of decisions) {
      const enrolAs = enrolmentIdOf(decision, visitorId, deployedIds);
      if (enrolAs === undefined) continue;
      const { experimentId, variantId } = decision;
      if (!isPositiveId(experimentId) || !isPositiveId(variantId)) continue;
      const key = exposureKey(experimentId, enrolAs);
      keyOfDecision.set(decision, key);
      const known = reported.has(key);
      reported.add(key);
      if (!known) queue.set(key, { experimentId, variantId, enrolAs });
    }
    if (queue.size >= MAX_EXPOSURES_PER_REQUEST) sendQueue();
    else if (queue.size > 0) armTimer();
  };

  const cancelSeeded = (decisions: readonly Decision[], visitorId: string | undefined): void => {
    for (const decision of decisions) {
      if (decision === null || typeof decision !== 'object' || !decision.enrolled) continue;
      const recorded = keyOfDecision.get(decision);
      const enrolAs = enrolmentIdOf(decision, visitorId);
      const keys = new Set<string>();
      if (recorded !== undefined) keys.add(recorded);
      if (enrolAs !== undefined) keys.add(exposureKey(decision.experimentId, enrolAs));
      for (const key of keys) {
        queue.delete(key);
        reported.add(key);
      }
    }
    if (queue.size === 0) clearTimer();
  };

  const record: ExposureReporter['record'] = (decisions, visitorId, deployedIds) => {
    if (!enabled) return;
    try {
      queueDecisions(decisions, visitorId, deployedIds);
    } catch (error) {
      unexpected(error);
    }
  };

  const seeded = (decisions: readonly Decision[], visitorId: string | undefined): void => {
    if (!enabled) return;
    try {
      cancelSeeded(decisions, visitorId);
    } catch (error) {
      unexpected(error);
    }
  };

  const onCall = (): void => {
    if (!timersOn) sendQueue();
  };

  const flush = async (): Promise<void> => {
    sendQueue();
    // allSettled, and each send already catches: a flush never rejects.
    await Promise.allSettled([...inFlight]);
  };

  const close = (): Promise<void> => {
    timersOn = false;
    return flush();
  };

  return { record, seeded, onCall, flush, close };
}
