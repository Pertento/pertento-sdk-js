import type { DecideIdentity, Decision, NotEnrolledDecision } from './evaluator';
import type { PertentoError } from './errors';
import type { FetchLike } from './http';
import type { SeedScriptOptions } from './seed-script';
import type { TrackOptions, TrackResult } from './track';
import { createConfigPoller } from './config-poller';
import { createErrorReporter } from './errors';
import { createVisitorId, decide, decideAll } from './evaluator';
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
  /** A `fetch` to use instead of the global one (a proxy agent, a test stub). */
  fetch?: FetchLike;
};

/** Who a decision is for. Give the ID kind the experiment assigns on; see the README. */
export type Identity = DecideIdentity;

export type Pertento = {
  /**
   * Resolves once the first config is loaded. Rejects after `timeoutMs` (default 5000), or at
   * once if the server key was refused, but the client keeps working and keeps trying either
   * way: until a config arrives every flag resolves to control with reason `unknown-key`.
   */
  ready: (timeoutMs?: number) => Promise<void>;
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
   * Pertento snippet, with the same visitor ID the decisions were made for.
   */
  seedScript: (
    decisions: readonly Decision[] | Readonly<Record<string, Decision>>,
    visitorId?: string,
    options?: SeedScriptOptions,
  ) => string;
  /**
   * Reports a conversion from your backend to `POST /sdk/events`. Needs the website's tracking
   * method set to "Server (SDK)". `keys` is required: the flag keys this person was decided on
   * (what you passed to `getVariant` or `getAll`), and `attributes` must be the ones used then.
   * At most once: no retry, 2 s timeout. Never rejects; missing or invalid `keys` sends nothing
   * and resolves `ok: false`. Check `ok` on the result, or `lastError`.
   */
  track: (event: string, options: TrackOptions) => Promise<TrackResult>;
  /**
   * The most recent failure, or null. Cleared when the part of the SDK it came from (config
   * or track) next succeeds. Every kind of failure is also logged once with `console.error`.
   */
  readonly lastError: PertentoError | null;
  /** Stops the config timer. Decisions keep using the last config; `track()` keeps working. */
  close: () => void;
};

const unknownKey = (): NotEnrolledDecision => ({
  experimentId: null,
  variantId: null,
  variantKey: null,
  payload: null,
  enrolled: false,
  reason: 'unknown-key',
});

function checkOptions({ websiteId, serverKey, pollIntervalMs }: PertentoOptions): void {
  if (!Number.isSafeInteger(websiteId) || websiteId <= 0) {
    throw new TypeError('createPertento: websiteId must be a positive integer');
  }
  if (typeof serverKey !== 'string' || serverKey.length === 0) {
    throw new TypeError('createPertento: serverKey is required (a psk_live_ key from the dashboard)');
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

  const evaluationFailed = (error: unknown): void => {
    errors.report({
      source: 'decide',
      kind: 'evaluation',
      message: `Evaluation failed, resolved to control: ${error instanceof Error ? error.message : String(error)}`,
    });
  };

  return {
    ready: (timeoutMs = DEFAULT_READY_TIMEOUT_MS) => poller.ready(timeoutMs),

    getVariant: async (key, identity = {}) => {
      poller.refreshIfStale();
      const loaded = poller.current();
      if (!loaded || typeof key !== 'string') return unknownKey();
      try {
        return await decide({ ...identity, config: loaded.config, salt: loaded.salt, key });
      } catch (error) {
        evaluationFailed(error);
        return unknownKey();
      }
    },

    getAll: async (identity = {}) => {
      poller.refreshIfStale();
      const loaded = poller.current();
      if (!loaded) return {};
      try {
        return await decideAll({ ...identity, config: loaded.config, salt: loaded.salt });
      } catch (error) {
        evaluationFailed(error);
        return {};
      }
    },

    createVisitorId,

    seedScript,

    track: (event, trackOptions) =>
      sendTrack({ baseUrl, serverKey, fetch, errors, event, options: trackOptions }),

    get lastError() {
      return errors.last();
    },

    close: () => poller.close(),
  };
}
