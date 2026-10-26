import type { SdkConfig } from './evaluator';
import type { ErrorReporter, PertentoErrorKind } from './errors';
import type { FetchLike, FetchResponse } from './http';
import { SDK_CONFIG_VERSION } from './evaluator';
import { isPlainObject, kindForStatus, serverMessage, thrownFetchError, timedFetch } from './http';

/** A config the SDK accepted, with the salt the evaluator needs. */
export type LoadedConfig = { config: SdkConfig; salt: string; etag: string | null };

export type ConfigPoller = {
  /** The last good config, or null before the first one (or after a version the SDK refuses). */
  current: () => LoadedConfig | null;
  /** One request now. Shares a request already in flight; never rejects. */
  refresh: () => Promise<void>;
  /** Starts a non-awaited refresh when the last attempt is older than the poll interval. */
  refreshIfStale: () => void;
  /** Resolves once a config is held; rejects after `timeoutMs`, or at once if polling has stopped. */
  ready: (timeoutMs: number) => Promise<void>;
  /** Stops the timer and any later refresh. The last config stays usable. */
  close: () => void;
};

export type CreateConfigPollerParams = {
  baseUrl: string;
  serverKey: string;
  websiteId: number;
  fetch: FetchLike;
  pollIntervalMs: number;
  /** Poll on a timer and load at once. Off for request-scoped runtimes (edge workers). */
  background: boolean;
  errors: ErrorReporter;
  now: () => number;
  requestTimeoutMs: number;
};

type ParsedConfig = { ok: true; config: SdkConfig; salt: string } | { ok: false; kind: PertentoErrorKind; message: string };

const refused = (kind: PertentoErrorKind, message: string): ParsedConfig => ({ ok: false, kind, message });

/**
 * Checks the envelope only. The evaluator is defensive about everything inside `experiments`
 * (spec/SPEC.md), so a malformed experiment resolves to control rather than throwing.
 */
export function parseConfigBody(body: unknown, websiteId: number): ParsedConfig {
  if (!isPlainObject(body)) return refused('invalid-config', 'The config response is not a JSON object');

  const { version, salt, experiments } = body;
  if (version !== SDK_CONFIG_VERSION) {
    return refused(
      'unsupported-version',
      `The config is version ${String(version)}, and this SDK understands version ${SDK_CONFIG_VERSION}. ` +
        'Every flag resolves to control (reason unknown-key) until @pertentoai/sdk is upgraded.',
    );
  }
  if (typeof salt !== 'string' || salt.length === 0) return refused('invalid-config', 'The config has no salt');
  if (!Array.isArray(experiments)) return refused('invalid-config', 'The config has no experiments list');
  if (body['websiteId'] !== websiteId) {
    return refused(
      'website-mismatch',
      `The server key belongs to website ${String(body['websiteId'])}, not website ${websiteId}. ` +
        'Check websiteId and serverKey; every flag resolves to control until they match.',
    );
  }

  const { salt: _salt, ...config } = body;
  return { ok: true, config: config as SdkConfig, salt };
}

type Waiter = { resolve: () => void; reject: (error: Error) => void };

/**
 * How long a run of 401s is retried before polling stops. The tracking server can briefly
 * refuse a valid key: a key created in the dashboard takes up to about 30 seconds to become
 * active on every server.
 */
export const UNAUTHORIZED_GRACE_MS = 2 * 60_000;
/** The first retry after a 401 inside the grace window; each later one doubles, up to the cap. */
export const RETRY_BACKOFF_BASE_MS = 2_000;
export const RETRY_BACKOFF_MAX_MS = 30_000;
/** `Retry-After` is honoured within these bounds, so a bad header can neither spin nor stall the client. */
export const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 5 * 60_000;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * `Retry-After` in milliseconds from `now`: delay-seconds or an HTTP date, clamped to
 * RETRY_AFTER_MIN_MS..RETRY_AFTER_MAX_MS. Null when absent or unreadable.
 */
export function retryAfterMs(header: string | null, now: number): number | null {
  const value = header?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return clamp(Number(value) * 1000, RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS);
  // An HTTP date always names its weekday and month; this keeps Date.parse from reading "-5" as a year.
  const at = /[A-Za-z]/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at)) return null;
  return clamp(at - now, RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS);
}

/** The delay before retry number `attempt` (1 for the first): exponential, capped. */
export const backoffMs = (attempt: number): number =>
  Math.min(RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));

/**
 * Keeps the website's SDK config current with `GET /sdk/config`.
 *
 * - 304 keeps the config; 200 replaces it; anything else keeps the last good one and records
 *   the error. A version the SDK does not understand, or another website's config, is "no
 *   config": every key is unknown until it is fixed.
 * - 503 and 429 are transient: the next request waits for `Retry-After` when the server sends
 *   one (1 second to 5 minutes), and otherwise for the next poll. The server answers 503 while
 *   it starts up.
 * - 401 is retried with backoff (2 s doubling to 30 s) for UNAUTHORIZED_GRACE_MS from the first
 *   401 in a row, because a key just created takes up to about 30 seconds to become active.
 *   Only when every answer in that window was 401 does polling stop for good: a revoked or
 *   mistyped key will not start working by retrying. Any other answer ends the run.
 * - While a retry is pending, no request is made before its time, whatever asks for one.
 * - In the background, a timer polls every `pollIntervalMs`. It is unref'd where the runtime
 *   allows it, so it never keeps a Node process alive, and `close()` clears it.
 * - Without a background timer (edge workers), a call that finds the config older than the
 *   interval starts a refresh it does not wait for, so the next request sees the new config.
 */
export function createConfigPoller(params: CreateConfigPollerParams): ConfigPoller {
  const { baseUrl, serverKey, websiteId, fetch, pollIntervalMs, background, errors, now, requestTimeoutMs } = params;

  let state: LoadedConfig | null = null;
  let inFlight: Promise<void> | null = null;
  let lastAttemptAt = -Infinity;
  let stopped = false;
  let closed = false;
  let timer: unknown = null;
  /** When the pending retry is due; null when requests follow the normal poll schedule. */
  let retryAt: number | null = null;
  let retryTimer: unknown = null;
  /** Retries made in the current run of 401s, for the backoff. */
  let unauthorizedRetries = 0;
  /** When the current run of 401s began; null when the last answer was not a 401. */
  let firstUnauthorizedAt: number | null = null;
  const waiters = new Set<Waiter>();

  const stopError = (): Error =>
    new Error(`[pertento] config polling stopped: ${errors.last()?.message ?? 'the client was closed'}`);

  const settleWaiters = (): void => {
    if (state) {
      for (const waiter of waiters) waiter.resolve();
      waiters.clear();
    } else if (stopped || closed) {
      for (const waiter of waiters) waiter.reject(stopError());
      waiters.clear();
    }
  };

  const report = (kind: PertentoErrorKind, message: string, status?: number, alwaysLog = false): void => {
    errors.report(
      status === undefined ? { source: 'config', kind, message } : { source: 'config', kind, message, status },
      { alwaysLog },
    );
  };

  const clearRetry = (): void => {
    retryAt = null;
    if (retryTimer !== null) clearTimeout(retryTimer as number);
    retryTimer = null;
  };

  /** No request before `delayMs` from now. With a background timer, one is made then. */
  const scheduleRetry = (delayMs: number): void => {
    retryAt = now() + delayMs;
    if (retryTimer !== null) clearTimeout(retryTimer as number);
    retryTimer = null;
    if (!background || timer === null) return;
    const handle: unknown = setTimeout(() => {
      retryTimer = null;
      void refresh();
    }, delayMs);
    retryTimer = handle;
    const unref = typeof handle === 'object' && handle !== null ? (handle as { unref?: unknown }).unref : undefined;
    if (typeof unref === 'function') unref.call(handle);
  };

  const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`;

  const accept = async (response: FetchResponse): Promise<void> => {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      report('invalid-config', 'The config response is not JSON', response.status);
      return;
    }
    const parsed = parseConfigBody(body, websiteId);
    if (!parsed.ok) {
      // A config the SDK cannot trust is no config: deciding on another website's experiments,
      // or on rules it does not understand, would put people in the wrong arm.
      if (parsed.kind !== 'invalid-config') state = null;
      report(parsed.kind, parsed.message, response.status);
      return;
    }
    state = { config: parsed.config, salt: parsed.salt, etag: response.headers.get('etag') };
    errors.clear('config');
  };

  const load = async (): Promise<void> => {
    lastAttemptAt = now();
    const headers: Record<string, string> = { authorization: `Bearer ${serverKey}`, accept: 'application/json' };
    if (state?.etag) headers['if-none-match'] = state.etag;

    let response: FetchResponse;
    try {
      response = await timedFetch({ fetch, url: `${baseUrl}/sdk/config`, init: { method: 'GET', headers }, timeoutMs: requestTimeoutMs });
    } catch (error) {
      const { kind, message } = thrownFetchError(error, requestTimeoutMs);
      report(kind, `Could not fetch the config: ${message}`);
      return;
    }

    if (response.status !== 401) {
      firstUnauthorizedAt = null;
      unauthorizedRetries = 0;
    }

    if (response.status === 304 && state) {
      clearRetry();
      errors.clear('config');
      return;
    }
    if (response.status === 200) {
      clearRetry();
      await accept(response);
      return;
    }

    const message = await serverMessage(response);
    if (response.status === 401) {
      const at = now();
      firstUnauthorizedAt ??= at;
      if (at - firstUnauthorizedAt >= UNAUTHORIZED_GRACE_MS) {
        stopped = true;
        clearTimer();
        clearRetry();
        report(
          'unauthorized',
          `The server key was refused (${message}) for ${seconds(UNAUTHORIZED_GRACE_MS)}. Config polling has stopped: ` +
            'check the key, or create a new one and restart.',
          401,
          true,
        );
        return;
      }
      unauthorizedRetries += 1;
      const delay = backoffMs(unauthorizedRetries);
      scheduleRetry(delay);
      report(
        'unauthorized',
        `The server key was refused (${message}). A key just created can take about 30 seconds to become ` +
          `active, so the client retries in ${seconds(delay)} and stops after ${seconds(UNAUTHORIZED_GRACE_MS)} of refusals.`,
        401,
      );
      return;
    }
    if (response.status === 503 || response.status === 429) {
      const delay = retryAfterMs(response.headers.get('retry-after'), now());
      if (delay !== null) scheduleRetry(delay);
      else clearRetry();
      const next = delay === null ? 'with the next poll' : `in ${seconds(delay)}, as Retry-After asks`;
      report(kindForStatus(response.status), `Config request failed: ${message}. Retrying ${next}.`, response.status);
      return;
    }
    clearRetry();
    report(kindForStatus(response.status), `Config request failed: ${message}`, response.status);
  };

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (stopped || closed) return Promise.resolve();
    // A retry is pending: nothing goes out before it is due, so a server that asked for room
    // (Retry-After, or a key not yet active) is not hit on every request.
    if (retryAt !== null && now() < retryAt) return Promise.resolve();
    inFlight = load()
      .catch((error: unknown) => {
        // load() handles every expected failure itself; this is a bug guard, never a throw.
        report('network', error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        inFlight = null;
        settleWaiters();
      });
    return inFlight;
  };

  function clearTimer(): void {
    if (timer !== null) clearInterval(timer as number);
    timer = null;
  }

  const refreshIfStale = (): void => {
    if (inFlight || stopped || closed) return;
    const due = retryAt !== null ? now() >= retryAt : now() - lastAttemptAt >= pollIntervalMs;
    if (due) void refresh();
  };

  const ready = (timeoutMs: number): Promise<void> => {
    if (state) return Promise.resolve();
    if (stopped || closed) return Promise.reject(stopError());

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          clearTimeout(deadline);
          resolve();
        },
        reject: (error) => {
          clearTimeout(deadline);
          reject(error);
        },
      };
      const deadline = setTimeout(() => {
        waiters.delete(waiter);
        const reason = errors.last()?.message ?? 'no response yet';
        reject(new Error(`[pertento] no config within ${timeoutMs} ms (${reason}). The client keeps trying.`));
      }, timeoutMs);
      waiters.add(waiter);
      void refresh();
    });
  };

  const close = (): void => {
    closed = true;
    clearTimer();
    clearRetry();
    settleWaiters();
  };

  if (background) {
    try {
      const handle: unknown = setInterval(() => void refresh(), pollIntervalMs);
      timer = handle;
      // Node and Bun return a Timeout object; unref() lets the process exit while it is pending.
      const unref = typeof handle === 'object' && handle !== null ? (handle as { unref?: unknown }).unref : undefined;
      if (typeof unref === 'function') unref.call(handle);
      void refresh();
    } catch {
      // A runtime that forbids timers here (an edge worker's global scope) falls back to the
      // lazy refresh that refreshIfStale and ready() provide.
      timer = null;
    }
  }

  return { current: () => state, refresh, refreshIfStale, ready, close };
}
