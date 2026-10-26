import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { FakeReply } from '../test/fake-fetch';
import { fakeFetch, hangingFetch } from '../test/fake-fetch';
import { createPertento } from './client';
import { createErrorReporter } from './errors';
import type { TrackOptions, TrackResult } from './track';
import { sendTrack, trackBody } from './track';

const KEY = 'psk_live_test_00000000000000000000000000000000000000';
const VISITOR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const KEYS = ['new-checkout'];
const CONFIG_404 = { status: 404, body: { error: 'No SDK config for this website' } };

let consoleError: ReturnType<typeof spyOn>;
beforeEach(() => {
  consoleError = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

/** A client whose config requests are answered (and ignored here); track calls get `reply`. */
const trackingClient = (reply: FakeReply) => {
  const { fetch, calls } = fakeFetch((call) => (call.url.endsWith('/sdk/config') ? CONFIG_404 : reply));
  const pertento = createPertento({ websiteId: 77, serverKey: KEY, baseUrl: 'https://t.example', fetch, background: false });
  const trackCalls = () => calls.filter(({ url }) => url.endsWith('/sdk/events'));
  return { pertento, trackCalls };
};

describe('trackBody', () => {
  test('wraps one event, sends the keys and leaves absent fields out', () => {
    expect(trackBody('signup', { keys: KEYS, visitorId: VISITOR })).toEqual({
      events: [{ name: 'signup' }],
      keys: KEYS,
      visitorId: VISITOR,
    });
    expect(
      trackBody('purchase', {
        keys: ['new-checkout', 'pro-banner'],
        id: 'Cust-1',
        attributes: { plan: 'pro' },
        data: { revenue: 4900, currency: 'SEK' },
      }),
    ).toEqual({
      events: [{ name: 'purchase', data: { revenue: 4900, currency: 'SEK' } }],
      keys: ['new-checkout', 'pro-banner'],
      id: 'Cust-1',
      attributes: { plan: 'pro' },
    });
  });
});

describe('track()', () => {
  test('POSTs /sdk/events with the key and returns the attributed map', async () => {
    const { pertento, trackCalls } = trackingClient({ status: 200, body: { ok: true, experimentVariantMap: { '501': '9002' } } });
    const result = await pertento.track('purchase', { keys: KEYS, visitorId: VISITOR, id: 'Cust-1', data: { revenue: 4900 } });

    expect(result).toEqual({ ok: true, experimentVariantMap: { '501': '9002' } });
    const [call] = trackCalls();
    expect(call!.url).toBe('https://t.example/sdk/events');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(call!.init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call!.init.body!)).toEqual({
      events: [{ name: 'purchase', data: { revenue: 4900 } }],
      keys: KEYS,
      visitorId: VISITOR,
      id: 'Cust-1',
    });
    expect(pertento.lastError).toBeNull();
  });

  test('409 (tracking method is not Server-side) resolves ok: false, records lastError, logs once', async () => {
    const message = 'This website reports conversions from the browser (tracking method ga4).';
    const { pertento, trackCalls } = trackingClient({ status: 409, body: { error: message } });

    const first = await pertento.track('purchase', { keys: KEYS, visitorId: VISITOR });
    await pertento.track('purchase', { keys: KEYS, visitorId: VISITOR });

    expect(first.ok).toBe(false);
    expect(first.ok ? null : first.error).toMatchObject({ source: 'track', kind: 'wrong-tracking-method', status: 409 });
    expect(pertento.lastError?.message).toContain('tracking method ga4');
    expect(trackCalls()).toHaveLength(2);
    const trackLogs = consoleError.mock.calls.filter(([line]) => String(line).includes('track:'));
    expect(trackLogs).toHaveLength(1);
  });

  test('times out after its limit, once, with no retry', async () => {
    const { fetch, calls } = hangingFetch();
    const errors = createErrorReporter({ now: Date.now, log: () => {} });
    const result = await sendTrack({
      baseUrl: 'https://t.example',
      serverKey: KEY,
      fetch,
      errors,
      event: 'purchase',
      options: { keys: KEYS, visitorId: VISITOR },
      timeoutMs: 20,
    });
    expect(result.ok ? null : result.error).toMatchObject({ kind: 'timeout' });
    expect(calls).toHaveLength(1);
  });

  test('a network failure resolves ok: false, never a throw', async () => {
    const { fetch } = fakeFetch(new TypeError('fetch failed'));
    const errors = createErrorReporter({ now: Date.now, log: () => {} });
    const result = await sendTrack({ baseUrl: 'https://t.example', serverKey: KEY, fetch, errors, event: 'x', options: { keys: KEYS, id: 'a' } });
    expect(result.ok ? null : result.error).toMatchObject({ kind: 'network' });
  });

  test('refuses locally without an ID or a valid event name, and sends nothing', async () => {
    const { pertento, trackCalls } = trackingClient({ status: 200, body: { ok: true, experimentVariantMap: {} } });
    expect((await pertento.track('purchase', { keys: KEYS })).ok).toBe(false);
    expect((await pertento.track('purchase', { keys: KEYS, visitorId: '' })).ok).toBe(false);
    expect((await pertento.track('', { keys: KEYS, visitorId: VISITOR })).ok).toBe(false);
    expect((await pertento.track('x'.repeat(101), { keys: KEYS, visitorId: VISITOR })).ok).toBe(false);
    expect(trackCalls()).toHaveLength(0);
    expect(pertento.lastError).toMatchObject({ kind: 'bad-request' });
  });

  // The server would refuse each of these with a 400; refusing here says why and sends nothing.
  test.each([
    ['a visitorId that is not a UUID', { visitorId: 'visitor-42' }],
    ['an id over 256 characters', { id: 'x'.repeat(257) }],
    ['more than 50 attributes', { visitorId: VISITOR, attributes: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, i])) }],
    ['an attribute list over 100 items', { visitorId: VISITOR, attributes: { tags: Array.from({ length: 101 }, (_, i) => `t${i}`) } }],
    ['attributes over 4 KB', { visitorId: VISITOR, attributes: { blob: 'x'.repeat(4_100) } }],
  ])('refuses %s locally, sends nothing', async (_, identity) => {
    const { pertento, trackCalls } = trackingClient({ status: 200, body: { ok: true, experimentVariantMap: {} } });
    const result = await pertento.track('purchase', { keys: KEYS, ...identity } as TrackOptions);
    expect(result.ok).toBe(false);
    expect(trackCalls()).toHaveLength(0);
    expect(pertento.lastError).toMatchObject({ source: 'track', kind: 'bad-request' });
  });

  test('accepts an id of exactly 256 characters and attributes at the limits', async () => {
    const { pertento, trackCalls } = trackingClient({ status: 200, body: { ok: true, experimentVariantMap: {} } });
    const attributes = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`a${i}`, i]));
    expect((await pertento.track('purchase', { keys: KEYS, id: 'x'.repeat(256), attributes })).ok).toBe(true);
    expect(trackCalls()).toHaveLength(1);
  });

  test.each([
    ['missing', undefined],
    ['not an array', 'new-checkout'],
    ['empty', []],
    ['more than 50', Array.from({ length: 51 }, (_, index) => `flag-${index}`)],
    ['uppercase', ['New-Checkout']],
    ['starting with a hyphen', ['-checkout']],
    ['longer than 64 characters', ['a'.repeat(65)]],
    ['not a string', [42]],
  ])('refuses keys that are %s, sends nothing and logs once', async (_, keys) => {
    const { pertento, trackCalls } = trackingClient({ status: 200, body: { ok: true, experimentVariantMap: {} } });
    const options = { keys, visitorId: VISITOR } as unknown as TrackOptions;

    const first = await pertento.track('purchase', options);
    await pertento.track('purchase', options);

    expect(first.ok).toBe(false);
    expect(first.ok ? null : first.error).toMatchObject({ source: 'track', kind: 'bad-request' });
    expect(pertento.lastError?.message).toContain('keys');
    expect(trackCalls()).toHaveLength(0);
    const trackLogs = consoleError.mock.calls.filter(([line]) => String(line).includes('track:'));
    expect(trackLogs).toHaveLength(1);
  });

  test('accepts 50 keys of 64 characters', async () => {
    const { pertento, trackCalls } = trackingClient({ status: 200, body: { ok: true, experimentVariantMap: {} } });
    const keys = Array.from({ length: 50 }, (_, index) => `${index}`.padEnd(64, 'a'));
    expect((await pertento.track('purchase', { keys, visitorId: VISITOR })).ok).toBe(true);
    expect(JSON.parse(trackCalls()[0]!.init.body!).keys).toEqual(keys);
  });

  test('a JavaScript caller that passes no options gets ok: false, never a throw', async () => {
    const { pertento, trackCalls } = trackingClient({ status: 200, body: { ok: true, experimentVariantMap: {} } });
    const untyped = pertento.track as unknown as (event: string) => Promise<TrackResult>;
    expect((await untyped('purchase')).ok).toBe(false);
    expect(trackCalls()).toHaveLength(0);
  });

  test('a later success clears a track error', async () => {
    let status = 429;
    const { fetch } = fakeFetch(() => ({ status, body: status === 200 ? { ok: true, experimentVariantMap: {} } : { error: 'slow down' } }));
    const errors = createErrorReporter({ now: Date.now, log: () => {} });
    const send = () => sendTrack({ baseUrl: 'https://t.example', serverKey: KEY, fetch, errors, event: 'x', options: { keys: KEYS, id: 'a' } });
    expect((await send()).ok).toBe(false);
    expect(errors.last()).toMatchObject({ kind: 'rate-limited' });
    status = 200;
    expect(await send()).toEqual({ ok: true, experimentVariantMap: {} });
    expect(errors.last()).toBeNull();
  });
});
