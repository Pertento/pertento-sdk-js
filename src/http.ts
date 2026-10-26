import type { PertentoErrorKind } from './errors';

/**
 * The part of `fetch` the SDK uses. Structural, so the global `fetch` of Node 20+, Bun, Deno
 * and edge workers fits, and so does a stub in a test.
 */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

export type FetchInit = {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
};

export type FetchResponse = {
  status: number;
  headers: { get: (name: string) => string | null };
  json: () => Promise<unknown>;
};

export const DEFAULT_BASE_URL = 'https://tracking.pertento.ai';

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The global fetch, called through globalThis so edge runtimes never see it detached ("Illegal invocation"). */
export const globalFetch: FetchLike = (url, init) => globalThis.fetch(url, init);

/** The tracking server answers a refusal with `{ error: string }`; anything else falls back to the status. */
export async function serverMessage(response: FetchResponse): Promise<string> {
  try {
    const body = await response.json();
    if (isPlainObject(body) && typeof body['error'] === 'string' && body['error'].length > 0) return body['error'];
  } catch {
    // Not JSON (a proxy's HTML error page, an empty body): the status says enough.
  }
  return `HTTP ${response.status}`;
}

export function kindForStatus(status: number): PertentoErrorKind {
  if (status === 400) return 'bad-request';
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 409) return 'wrong-tracking-method';
  if (status === 429) return 'rate-limited';
  return 'http';
}

const isAbortError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';

/** A fetch that threw: a timeout when our own AbortController fired, a network failure otherwise. */
export function thrownFetchError(error: unknown, timeoutMs: number): { kind: PertentoErrorKind; message: string } {
  if (isAbortError(error)) return { kind: 'timeout', message: `No response within ${timeoutMs} ms` };
  return { kind: 'network', message: error instanceof Error ? error.message : String(error) };
}

type TimedFetchParams = { fetch: FetchLike; url: string; init: Omit<FetchInit, 'signal'>; timeoutMs: number };

/**
 * One fetch with its own timeout. The timer is always cleared, and unref'd where the runtime
 * allows it, so a request that hangs never holds a Node process open on its own.
 */
export async function timedFetch({ fetch, url, init, timeoutMs }: TimedFetchParams): Promise<FetchResponse> {
  const controller = new AbortController();
  const timer: unknown = setTimeout(() => controller.abort(), timeoutMs);
  const unref = typeof timer === 'object' && timer !== null ? (timer as { unref?: unknown }).unref : undefined;
  if (typeof unref === 'function') unref.call(timer);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer as number);
  }
}
