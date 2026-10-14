import type { FetchInit, FetchLike, FetchResponse } from '../src/http';

export type FakeReply = { status: number; body?: unknown; headers?: Record<string, string> };
export type FakeCall = { url: string; init: FetchInit };
type Responder = FakeReply | Error | ((call: FakeCall) => FakeReply | Promise<FakeReply>);

const toResponse = ({ status, body, headers = {} }: FakeReply): FetchResponse => {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return structuredClone(body);
    },
  };
};

/** A fetch that answers from a script of replies; the last one repeats. Records every call. */
export function fakeFetch(...script: Responder[]): { fetch: FetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    const responder = script[Math.min(calls.length - 1, script.length - 1)];
    if (responder === undefined) throw new Error('fakeFetch: no reply scripted');
    if (responder instanceof Error) throw responder;
    return toResponse(typeof responder === 'function' ? await responder(call) : responder);
  };
  return { fetch, calls };
}

/** A fetch that never answers until its AbortSignal fires, then rejects like the real one. */
export const hangingFetch = (): { fetch: FetchLike; calls: FakeCall[] } => {
  const calls: FakeCall[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
  };
  return { fetch, calls };
};

export const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
