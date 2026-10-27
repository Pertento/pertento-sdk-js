import type { LoadedConfig } from './config-poller';
import type { DecideIdentity, Decision, NotEnrolledDecision } from './evaluator';
import type { PertentoError } from './errors';
import type { FetchLike } from './http';
import type { SeedScriptOptions } from './seed-script';
import type { TrackOptions, TrackResult } from './track';
import { createConfigPoller } from './config-poller';
import { createErrorReporter } from './errors';
import { createVisitorId, decide, decideAll, isUuid } from './evaluator';
import { createExposureReporter, deployedEnrolmentIds } from './exposures';
import { DEFAULT_BASE_URL, globalFetch } from './http';
import { seedScript } from './seed-script';
import { sendTrack } from './track';

/** How often the config is refreshed by default. */
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** The shortest poll interval accepted. The server allows 120 config requests a minute per key. */
const MIN_POLL_INTERVAL_MS = 5_000;
/** How long `ready()` waits by default. */
const DEFAULT_READY_TIMEOUT_MS = 5_000;
const CONFIG_REQUEST_TIMEOUT_MS = 10_000;

export type PertentoOptions = {
  /** Your website's ID in Pertento. The config is checked against it. */
  websiteId: number;
  /** A server key (`psk_live_...`) from the dashboard. Keep it on the server; never ship it to a browser. */
  serverKey: string;
  /** Defaults to `https://tracking.pertento.ai`. */
  baseUrl?: string;
  /** How often the config is refreshed, in ms. Default 30000, minimum 5000. */
  pollIntervalMs?: number;
  /**
   * Load the config at once and refresh it on a timer (default `true`). Set `false` in
   * request-scoped runtimes such as Cloudflare Workers, Vercel Edge or Deno Deploy, where no
   * timer outlives a request: the config then loads on the first `ready()` or `getVariant()`,
   * and a call that finds it older than `pollIntervalMs` refreshes it without waiting.
   */
  background?: boolean;
  /**
   * Report the enrolled decisions `getVariant` and `getAll` make to Pertento (default `true`),
   * so experiments decided only on your server get results. Decisions served from a deployed
   * experiment are reported too, and count toward sessions as a deployed variant does. They are
   * batched and sent at most once; see the README. Decisions you put in a page seed are left to
   * the browser. Set `false` to send nothing.
   */
  exposures?: boolean;
  /** A `fetch` to use instead of the global one (a proxy agent, a test stub). */
  fetch?: FetchLike;
};

/** Who a decision is for. Give the ID kind the experiment assigns on; see the README. */
export type Identity = DecideIdentity;

export type Pertento = {
  /**
   * Resolves `true` once the first config is loaded, and `false` when none arrives within
   * `timeoutMs` (default 5000). It never rejects, so `await pertento.ready()` is safe at
   * startup: a slow or unreachable Pertento, or a refused key, must not stop your server.
   * It gives up early when no further attempt could land in time, and at once if polling has
   * stopped; `lastError` says why. The client keeps working either way, and keeps trying
   * unless polling stopped: until a config arrives every flag resolves to control with reason
   * `unknown-key`. A refused key (401) is retried for 2 minutes, since a key just created takes
   * up to about 30 seconds to become active; only then does polling stop for good.
   */
  ready: (timeoutMs?: number) => Promise<boolean>;
  /**
   * The variant of one flag for one person. Never rejects: without a config, or for a key no
   * experiment has, it resolves to `{ enrolled: false, reason: 'unknown-key', variantKey: null, ... }`.
   */
  getVariant: (key: string, identity?: Identity) => Promise<Decision>;
  /** `getVariant` for every experiment in the config, keyed by flag key. `{}` before a config. Never rejects. */
  getAll: (identity?: Identity) => Promise<Record<string, Decision>>;
  /** A new random visitor ID (a lowercase UUID) for a visitor who has none yet. */
  createVisitorId: () => string;
  /**
   * `<script>window.PertentoSeed=...;</script>` for the page. Print it in `<head>` before the
   * Pertento snippet, with the same visitor ID the decisions were made for. The browser enrols
   * what the seed carries, so the client stops reporting those decisions itself.
   */
  seedScript: (
    decisions: readonly Decision[] | Readonly<Record<string, Decision>>,
    visitorId?: string,
    options?: SeedScriptOptions,
  ) => string;
  /**
   * Reports a conversion from your backend to `POST /sdk/events`. Needs the website's tracking
   * method set to "Server-side". `keys` is required: the flag keys this person was decided on
   * (what you passed to `getVariant` or `getAll`), and `attributes` must be the ones used then.
   * At most once: no retry, 2 s timeout. Never rejects; missing or invalid `keys` sends nothing
   * and resolves `ok: false`. Check `ok` on the result, or `lastError`.
   */
  track: (event: string, options: TrackOptions) => Promise<TrackResult>;
  /**
   * Sends the exposures waiting in the queue and resolves when they, and any already on their
   * way, are done. Never rejects. In an edge worker pass it to `waitUntil`, so the batch is not
   * cut off when the response is sent.
   */
  flush: () => Promise<void>;
  /**
   * The most recent failure, or null. Cleared when the part of the SDK it came from (config,
   * track or exposures) next succeeds. Every kind of failure is also logged once with
   * `console.error`.
   */
  readonly lastError: PertentoError | null;
  /**
   * Sends the queued exposures and stops the config and exposure timers. Resolves when the
   * exposures are sent; never rejects. Decisions keep using the last config, `track()` keeps
   * working, and later exposures are sent on the next call or `flush()`.
   */
  close: () => Promise<void>;
};

const unknownKey = (): NotEnrolledDecision => ({
  experimentId: null,
  variantId: null,
  variantKey: null,
  payload: null,
  enrolled: false,
  reason: 'unknown-key',
});

/** A server key as the dashboard issues it. */
const SERVER_KEY_PATTERN = /^psk_live_[A-Za-z0-9_-]{43}$/;

/**
 * The identity as the evaluator should see it: a `visitorId` that is not a UUID is left out,
 * as the server and the page seed would refuse it, so the decision says `no-id` (or uses `id`)
 * rather than enrolling someone the server will not recognise. A valid one is lowercased, as
 * the server stores it.
 */
function cleanIdentity(identity: Identity): Identity {
  const { visitorId, ...rest } = identity;
  if (visitorId === undefined) return identity;
  return isUuid(visitorId) ? { ...rest, visitorId: visitorId.toLowerCase() } : rest;
}

function checkOptions({ websiteId, serverKey, pollIntervalMs }: PertentoOptions): void {
  if (!Number.isSafeInteger(websiteId) || websiteId <= 0) {
    throw new TypeError('createPertento: websiteId must be a positive integer');
  }
  if (typeof serverKey !== 'string' || serverKey.length === 0) {
    throw new TypeError('createPertento: serverKey is required (a psk_live_ key from the dashboard)');
  }
  if (!SERVER_KEY_PATTERN.test(serverKey)) {
    throw new TypeError('createPertento: serverKey is not a server key; copy the whole psk_live_ key from the dashboard');
  }
  if (pollIntervalMs !== undefined && !(Number.isFinite(pollIntervalMs) && pollIntervalMs >= MIN_POLL_INTERVAL_MS)) {
    throw new TypeError(`createPertento: pollIntervalMs must be at least ${MIN_POLL_INTERVAL_MS}`);
  }
}

/**
 * Creates a Pertento client. Create one per process (or per worker isolate) and share it:
 * each client polls the config on its own.
 *
 * Throws only on invalid options. Everything after that (network failures, a refused key, a
 * config it cannot use) resolves to control and is reported through `lastError`.
 */
export function createPertento(options: PertentoOptions): Pertento {
  checkOptions(options);
  const { websiteId, serverKey } = options;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetch = options.fetch ?? globalFetch;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const background = (options.background ?? true) && typeof setInterval === 'function';
  const exposuresOn = options.exposures ?? true;

  const errors = createErrorReporter({ now: Date.now, log: (message) => console.error(message) });
  const poller = createConfigPoller({
    baseUrl,
    serverKey,
    websiteId,
    fetch,
    pollIntervalMs,
    background,
    errors,
    now: Date.now,
    requestTimeoutMs: CONFIG_REQUEST_TIMEOUT_MS,
  });

  const exposures = createExposureReporter({
    baseUrl,
    serverKey,
    fetch,
    errors,
    background: background && typeof setTimeout === 'function',
    enabled: exposuresOn,
  });

  const evaluationFailed = (error: unknown): void => {
    errors.report({
      source: 'decide',
      kind: 'evaluation',
      message: `Evaluation failed, resolved to control: ${error instanceof Error ? error.message : String(error)}`,
    });
  };

  /** Queues what the decisions report. Never rejects; a deployed decision's ID is derived first. */
  const recordExposures = async (decisions: readonly Decision[], loaded: LoadedConfig, identity: Identity) => {
    if (!exposuresOn) return;
    let deployedIds: Map<Decision, string> | undefined;
    try {
      deployedIds = await deployedEnrolmentIds({ decisions, config: loaded.config, salt: loaded.salt, identity });
    } catch (error) {
      errors.report({
        source: 'exposures',
        kind: 'evaluation',
        message: `Deployed decisions not reported: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    exposures.record(decisions, identity.visitorId, deployedIds);
  };

  return {
    ready: (timeoutMs = DEFAULT_READY_TIMEOUT_MS) => poller.ready(timeoutMs),

    getVariant: async (key, identity = {}) => {
      exposures.onCall();
      poller.refreshIfStale();
      const loaded = poller.current();
      if (!loaded || typeof key !== 'string') return unknownKey();
      const cleaned = cleanIdentity(identity);
      let decision: Decision;
      try {
        decision = await decide({ ...cleaned, config: loaded.config, salt: loaded.salt, key });
      } catch (error) {
        evaluationFailed(error);
        return unknownKey();
      }
      await recordExposures([decision], loaded, cleaned);
      return decision;
    },

    getAll: async (identity = {}) => {
      exposures.onCall();
      poller.refreshIfStale();
      const loaded = poller.current();
      if (!loaded) return {};
      const cleaned = cleanIdentity(identity);
      let decisions: Record<string, Decision>;
      try {
        decisions = await decideAll({ ...cleaned, config: loaded.config, salt: loaded.salt });
      } catch (error) {
        evaluationFailed(error);
        return {};
      }
      await recordExposures(Object.values(decisions), loaded, cleaned);
      return decisions;
    },

    createVisitorId,

    seedScript: (decisions, visitorId, seedOptions) => {
      const script = seedScript(decisions, visitorId, seedOptions);
      const list = Array.isArray(decisions) ? decisions : Object.values(decisions as Record<string, Decision>);
      exposures.seeded(list, isUuid(visitorId) ? visitorId.toLowerCase() : undefined);
      return script;
    },

    track: (event, trackOptions) => {
      exposures.onCall();
      return sendTrack({ baseUrl, serverKey, fetch, errors, event, options: trackOptions });
    },

    flush: () => exposures.flush(),

    get lastError() {
      return errors.last();
    },

    close: () => {
      poller.close();
      return exposures.close();
    },
  };
}
