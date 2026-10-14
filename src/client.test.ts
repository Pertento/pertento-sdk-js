import type { SdkConfig } from './evaluator';
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import rawVectors from '../spec/vectors.json';
import { fakeFetch, hangingFetch, tick } from '../test/fake-fetch';
import { createPertento } from './client';
import { createConfigPoller } from './config-poller';
import { createErrorReporter } from './errors';

const vectors = rawVectors as unknown as { decisionConfig: SdkConfig; decisionSalt: string };
const CONFIG = vectors.decisionConfig;
const SALT = vectors.decisionSalt;
const WEBSITE_ID = CONFIG.websiteId;
const KEY = 'psk_live_test';
const VISITOR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const configReply = (overrides: Record<string, unknown> = {}, etag = '"v1"') => ({
  status: 200,
  body: { ...CONFIG, salt: SALT, ...overrides },
  headers: { ETag: etag },
});

const unknownKey = {
  experimentId: null,
  variantId: null,
  variantKey: null,
  payload: null,
  enrolled: false,
  reason: 'unknown-key',
};

let consoleError: ReturnType<typeof spyOn>;
beforeEach(() => {
  consoleError = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  setSystemTime();
});

const client = (fetch: ReturnType<typeof fakeFetch>['fetch'], extra: { background?: boolean } = {}) =>
  createPertento({ websiteId: WEBSITE_ID, serverKey: KEY, baseUrl: 'https://t.example/', fetch, ...extra });

describe('createPertento options', () => {
  test('throws on a missing key, a bad website ID or a too-short poll interval', () => {
    const { fetch } = fakeFetch(configReply());
    expect(() => createPertento({ websiteId: 0, serverKey: KEY, fetch })).toThrow(TypeError);
    expect(() => createPertento({ websiteId: 1, serverKey: '', fetch })).toThrow(TypeError);
    expect(() => createPertento({ websiteId: 1, serverKey: KEY, pollIntervalMs: 100, fetch })).toThrow(TypeError);
  });
});

describe('first load', () => {
  test('GETs /sdk/config with the key, then decides against it', async () => {
    const { fetch, calls } = fakeFetch(configReply());
    const pertento = client(fetch);
    await pertento.ready();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://t.example/sdk/config');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.init.headers['if-none-match']).toBeUndefined();

    const decision = await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    expect(decision.enrolled).toBe(true);
    expect(decision.experimentId).toBe(501);
    expect(pertento.lastError).toBeNull();
    pertento.close();
  });

  test('before any config, getVariant is unknown-key and getAll is empty, never a throw', async () => {
    const { fetch } = hangingFetch();
    const pertento = client(fetch);
    expect(await pertento.getVariant('new-checkout', { visitorId: VISITOR })).toEqual(unknownKey);
    expect(await pertento.getAll({ visitorId: VISITOR })).toEqual({});
    pertento.close();
  });

  test('ready() rejects after its timeout, and the client keeps working when the config arrives', async () => {
    let answer: (() => void) | undefined;
    const { fetch } = fakeFetch(
      () =>
        new Promise((resolve) => {
          answer = () => resolve(configReply());
        }),
    );
    const pertento = client(fetch);
    await expect(pertento.ready(20)).rejects.toThrow('no config within 20 ms');

    answer?.();
    await tick();
    expect((await pertento.getVariant('new-checkout', { visitorId: VISITOR })).enrolled).toBe(true);
    await pertento.ready();
    pertento.close();
  });
});

describe('refresh', () => {
  test('304 keeps the config and sends the etag back', async () => {
    const { fetch, calls } = fakeFetch(configReply(), { status: 304 });
    const errors = createErrorReporter({ now: Date.now, log: () => {} });
    const poller = createConfigPoller({
      baseUrl: 'https://t.example',
      serverKey: KEY,
      websiteId: WEBSITE_ID,
      fetch,
      pollIntervalMs: 30_000,
      background: false,
      errors,
      now: Date.now,
      requestTimeoutMs: 1_000,
    });
    await poller.refresh();
    const first = poller.current();
    await poller.refresh();

    expect(calls[1]!.init.headers['if-none-match']).toBe('"v1"');
    expect(poller.current()).toBe(first);
    expect(first?.salt).toBe(SALT);
    expect(errors.last()).toBeNull();
  });

  test('200 replaces the config', async () => {
    const changed = { experiments: CONFIG.experiments.filter((experiment) => experiment.key !== 'new-checkout') };
    const { fetch } = fakeFetch(configReply(), configReply(changed, '"v2"'));
    const pertento = client(fetch, { background: false });
    await pertento.ready();
    expect((await pertento.getVariant('new-checkout', { visitorId: VISITOR })).enrolled).toBe(true);

    setSystemTime(new Date(Date.now() + 31_000));
    await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    await tick();
    expect(await pertento.getVariant('new-checkout', { visitorId: VISITOR })).toEqual(unknownKey);
  });

  test('a failure keeps the last good config, records lastError and logs once per kind', async () => {
    const { fetch } = fakeFetch(configReply(), { status: 500, body: { error: 'boom' } });
    const pertento = client(fetch, { background: false });
    await pertento.ready();

    for (const minutes of [1, 2]) {
      setSystemTime(new Date(Date.now() + minutes * 60_000));
      await pertento.getVariant('new-checkout', { visitorId: VISITOR });
      await tick();
    }

    expect((await pertento.getVariant('new-checkout', { visitorId: VISITOR })).enrolled).toBe(true);
    expect(pertento.lastError).toMatchObject({ source: 'config', kind: 'http', status: 500 });
    expect(pertento.lastError?.message).toContain('boom');
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test('a network failure is recorded as such', async () => {
    const { fetch } = fakeFetch(new TypeError('fetch failed'));
    const pertento = client(fetch);
    await expect(pertento.ready(50)).rejects.toThrow('fetch failed');
    expect(pertento.lastError).toMatchObject({ source: 'config', kind: 'network' });
    pertento.close();
  });

  test('401 stops polling, rejects ready() at once and logs once', async () => {
    const { fetch, calls } = fakeFetch({ status: 401, body: { error: 'Invalid server key' } });
    const pertento = client(fetch, { background: false });
    await expect(pertento.ready(5_000)).rejects.toThrow('Invalid server key');

    setSystemTime(new Date(Date.now() + 10 * 60_000));
    expect(await pertento.getVariant('new-checkout', { visitorId: VISITOR })).toEqual(unknownKey);
    await tick();
    await expect(pertento.ready()).rejects.toThrow('stopped');

    expect(calls).toHaveLength(1);
    expect(pertento.lastError).toMatchObject({ kind: 'unauthorized', status: 401 });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test('refuses a config version it does not understand, as no config', async () => {
    const { fetch } = fakeFetch(configReply(), configReply({ version: 2 }, '"v2"'));
    const pertento = client(fetch, { background: false });
    await pertento.ready();

    setSystemTime(new Date(Date.now() + 31_000));
    await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    await tick();

    expect(await pertento.getVariant('new-checkout', { visitorId: VISITOR })).toEqual(unknownKey);
    expect(await pertento.getAll({ visitorId: VISITOR })).toEqual({});
    expect(pertento.lastError).toMatchObject({ kind: 'unsupported-version' });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test("refuses another website's config", async () => {
    const { fetch } = fakeFetch(configReply({ websiteId: WEBSITE_ID + 1 }));
    const pertento = client(fetch);
    await expect(pertento.ready(50)).rejects.toThrow();
    expect(pertento.lastError).toMatchObject({ kind: 'website-mismatch' });
    expect(await pertento.getVariant('new-checkout', { visitorId: VISITOR })).toEqual(unknownKey);
    pertento.close();
  });

  test('a malformed body keeps the last good config', async () => {
    const { fetch } = fakeFetch(configReply(), { status: 200, body: { version: 1, experiments: [] } });
    const pertento = client(fetch, { background: false });
    await pertento.ready();
    setSystemTime(new Date(Date.now() + 31_000));
    await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    await tick();
    expect((await pertento.getVariant('new-checkout', { visitorId: VISITOR })).enrolled).toBe(true);
    expect(pertento.lastError).toMatchObject({ kind: 'invalid-config' });
  });
});

describe('without a background timer (edge workers)', () => {
  test('nothing is fetched until the first call, and a stale config refreshes without being awaited', async () => {
    let release: (() => void) | undefined;
    const changed = { experiments: [] };
    const { fetch, calls } = fakeFetch(
      configReply(),
      () =>
        new Promise((resolve) => {
          release = () => resolve(configReply(changed, '"v2"'));
        }),
    );
    const pertento = client(fetch, { background: false });
    expect(calls).toHaveLength(0);

    await pertento.ready();
    expect(calls).toHaveLength(1);

    // Fresh: no request.
    await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    expect(calls).toHaveLength(1);

    // Stale: the call answers from the old config at once and starts one refresh.
    setSystemTime(new Date(Date.now() + 31_000));
    expect((await pertento.getVariant('new-checkout', { visitorId: VISITOR })).enrolled).toBe(true);
    await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    expect(calls).toHaveLength(2);

    release?.();
    await tick();
    expect(await pertento.getVariant('new-checkout', { visitorId: VISITOR })).toEqual(unknownKey);
  });
});

describe('background timer', () => {
  test('polls on its interval until close()', async () => {
    const { fetch, calls } = fakeFetch(configReply(), { status: 304 });
    const poller = createConfigPoller({
      baseUrl: 'https://t.example',
      serverKey: KEY,
      websiteId: WEBSITE_ID,
      fetch,
      pollIntervalMs: 10,
      background: true,
      errors: createErrorReporter({ now: Date.now, log: () => {} }),
      now: Date.now,
      requestTimeoutMs: 1_000,
    });
    await tick(55);
    poller.close();
    const polled = calls.length;
    expect(polled).toBeGreaterThanOrEqual(3);
    await tick(30);
    expect(calls).toHaveLength(polled);
    expect(poller.current()?.etag).toBe('"v1"');
  });

  test('close() rejects a pending ready()', async () => {
    const { fetch } = hangingFetch();
    const pertento = client(fetch);
    const ready = pertento.ready(5_000);
    pertento.close();
    await expect(ready).rejects.toThrow();
  });
});
