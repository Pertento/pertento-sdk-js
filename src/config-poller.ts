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
 * Keeps the website's SDK config current with `GET /sdk/config`.
 *
 * - 304 keeps the config; 200 replaces it; anything else keeps the last good one and records
 *   the error. A version the SDK does not understand, or another website's config, is "no
 *   config": every key is unknown until it is fixed.
 * - 401 stops polling for good: a revoked or mistyped key will not start working by retrying.
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

  const report = (kind: PertentoErrorKind, message: string, status?: number): void => {
    errors.report(status === undefined ? { source: 'config', kind, message } : { source: 'config', kind, message, status });
  };

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

    if (response.status === 304 && state) {
      errors.clear('config');
      return;
    }
    if (response.status === 200) {
      await accept(response);
      return;
    }

    const message = await serverMessage(response);
    if (response.status === 401) {
      stopped = true;
      clearTimer();
      report('unauthorized', `The server key was refused (${message}). Config polling has stopped.`, 401);
      return;
    }
    report(kindForStatus(response.status), `Config request failed: ${message}`, response.status);
  };

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (stopped || closed) return Promise.resolve();
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
    if (now() - lastAttemptAt >= pollIntervalMs) void refresh();
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
