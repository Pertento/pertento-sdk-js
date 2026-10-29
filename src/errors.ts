/** What went wrong. Stable strings, safe to branch on in your own code. */
export type PertentoErrorKind =
  /**
   * The server key was refused (401). Config polling retries for a grace period (a new key
   * takes a moment to become active), then stops; create a new key in the dashboard.
   */
  | 'unauthorized'
  /** The website has no SDK config (404). */
  | 'not-found'
  /** Too many requests for this server key (429). */
  | 'rate-limited'
  /** The website's tracking method is not "Server-side", so `track()` was refused (409). */
  | 'wrong-tracking-method'
  /** The request was refused as malformed (400), or `track()` was called without an ID or event name. */
  | 'bad-request'
  /** Any other HTTP status. */
  | 'http'
  /** The request never got a response (DNS, TLS, connection reset, a fetch that threw). */
  | 'network'
  /** The request took longer than its timeout and was abandoned. */
  | 'timeout'
  /** The config response was not the shape this SDK expects. The last good config is kept. */
  | 'invalid-config'
  /** The config uses a version this SDK does not understand. Treated as no config: upgrade the SDK. */
  | 'unsupported-version'
  /** The config belongs to another website than the `websiteId` you passed. Treated as no config. */
  | 'website-mismatch'
  /**
   * Evaluating a flag failed inside Web Crypto. From `decide`, the call resolved to control; from
   * `exposures`, the decision was returned but not reported.
   */
  | 'evaluation';

/**
 * Which part of the SDK the error came from. `exposures` is the background report of enrolled
 * and deployed decisions: a batch that failed was dropped, and the decisions themselves were unaffected.
 */
export type PertentoErrorSource = 'config' | 'track' | 'decide' | 'exposures';

/** The most recent failure, as `client.lastError` shows it. */
export type PertentoError = {
  source: PertentoErrorSource;
  kind: PertentoErrorKind;
  /** Human readable; for an HTTP refusal, the server's own message when it gave one. */
  message: string;
  /** The HTTP status, when there was a response. */
  status?: number;
  /** Epoch milliseconds. */
  at: number;
};

export type ReportedError = Omit<PertentoError, 'at'>;

/** `alwaysLog` logs even when this source and kind were logged before: for a change of state worth a second line. */
export type ReportOptions = { alwaysLog?: boolean };

export type ErrorReporter = {
  /** Records the error as `last` and logs it, once per source and kind for the client's lifetime. */
  report: (error: ReportedError, options?: ReportOptions) => PertentoError;
  /** Clears `last` when it came from `source`: that part of the SDK has recovered. */
  clear: (source: PertentoErrorSource) => void;
  last: () => PertentoError | null;
};

type CreateErrorReporterParams = { now: () => number; log: (message: string) => void };

/**
 * Errors never throw into the caller's request path. They land in `lastError` and are logged
 * once per kind, so a misconfigured key does not write a line per request into the
 * customer's logs.
 */
export function createErrorReporter({ now, log }: CreateErrorReporterParams): ErrorReporter {
  let last: PertentoError | null = null;
  const logged = new Set<string>();

  return {
    report: (error, options) => {
      const recorded: PertentoError = { ...error, at: now() };
      last = recorded;
      const onceKey = `${error.source}:${error.kind}`;
      if (!logged.has(onceKey) || options?.alwaysLog === true) {
        logged.add(onceKey);
        log(`[pertento] ${error.source}: ${error.message}`);
      }
      return recorded;
    },
    clear: (source) => {
      if (last?.source === source) last = null;
    },
    last: () => last,
  };
}
