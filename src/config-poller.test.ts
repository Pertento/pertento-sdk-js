import type { SdkConfig } from './evaluator';
import type { FakeReply } from '../test/fake-fetch';
import { describe, expect, test } from 'bun:test';
import rawVectors from '../spec/vectors.json';
import { fakeFetch, tick } from '../test/fake-fetch';
import {
  backoffMs,
  createConfigPoller,
  RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MIN_MS,
  RETRY_BACKOFF_MAX_MS,
  retryAfterMs,
  UNAUTHORIZED_GRACE_MS,
} from './config-poller';
import { createErrorReporter } from './errors';

const vectors = rawVectors as unknown as { decisionConfig: SdkConfig; decisionSalt: string };
const CONFIG = vectors.decisionConfig;
const POLL_INTERVAL_MS = 30_000;

const CONFIG_200: FakeReply = { status: 200, body: { ...CONFIG, salt: vectors.decisionSalt }, headers: { ETag: '"v1"' } };
const REFUSED_401: FakeReply = { status: 401, body: { error: 'Invalid server key' } };

/** A poller without a background timer, on a clock the test moves by hand. */
function fakeClockPoller(...script: FakeReply[]) {
  let clock = 1_700_000_000_000;
  const logs: string[] = [];
  const { fetch, calls } = fakeFetch(...script);
  const errors = createErrorReporter({ now: () => clock, log: (line) => logs.push(line) });
  const poller = createConfigPoller({
    baseUrl: 'https://t.example',
    serverKey: 'psk_live_test',
    websiteId: CONFIG.websiteId,
    fetch,
    pollIntervalMs: POLL_INTERVAL_MS,
    background: false,
    errors,
    now: () => clock,
    requestTimeoutMs: 1_000,
  });
  /** Moves the clock, then does what a getVariant call does: a refresh if one is due. */
  const advance = async (ms: number): Promise<void> => {
    clock += ms;
    poller.refreshIfStale();
    await tick();
  };
  return { poller, errors, calls, logs, advance };
}

describe('retryAfterMs', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');

  test('reads delay-seconds and HTTP dates', () => {
    expect(retryAfterMs('120', now)).toBe(120_000);
    expect(retryAfterMs(' 5 ', now)).toBe(5_000);
    expect(retryAfterMs('Wed, 14 Oct 2026 12:00:30 GMT', now)).toBe(30_000);
  });

  test('clamps to sane bounds', () => {
    expect(retryAfterMs('0', now)).toBe(RETRY_AFTER_MIN_MS);
    expect(retryAfterMs('Wed, 14 Oct 2026 11:00:00 GMT', now)).toBe(RETRY_AFTER_MIN_MS);
    expect(retryAfterMs('86400', now)).toBe(RETRY_AFTER_MAX_MS);
  });

  test('ignores an absent or unreadable header', () => {
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs('', now)).toBeNull();
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs('-5', now)).toBeNull();
  });
});

describe('backoffMs', () => {
  test('doubles from 2 s and stops at the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(backoffMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(backoffMs(100)).toBe(RETRY_BACKOFF_MAX_MS);
  });
});

describe('401 grace window', () => {
  test('a new key refused at first recovers once the server accepts it', async () => {
    const { poller, errors, calls, advance } = fakeClockPoller(REFUSED_401, REFUSED_401, CONFIG_200);

    await poller.refresh();
    expect(calls).toHaveLength(1);
    expect(errors.last()).toMatchObject({ source: 'config', kind: 'unauthorized', status: 401 });
    expect(errors.last()?.message).toContain('retries in 2 s');

    // Nothing goes out before the retry is due, whoever asks.
    await poller.refresh();
    await advance(1_000);
    expect(calls).toHaveLength(1);

    await advance(1_000);
    expect(calls).toHaveLength(2);
    expect(errors.last()?.message).toContain('retries in 4 s');

    await advance(4_000);
    expect(calls).toHaveLength(3);
    expect(poller.current()?.etag).toBe('"v1"');
    expect(errors.last()).toBeNull();
    await poller.ready(10);
  });

  test('401s for longer than the window stop polling for good', async () => {
    const { poller, errors, calls, logs, advance } = fakeClockPoller(REFUSED_401);

    await poller.refresh();
    for (let elapsed = 30_000; elapsed < UNAUTHORIZED_GRACE_MS; elapsed += 30_000) await advance(30_000);
    expect(calls).toHaveLength(4);
    // Still inside the window: retrying, not stopped.
    await expect(poller.ready(1)).rejects.toThrow('no config within');

    await advance(30_000);
    expect(calls).toHaveLength(5);
    expect(errors.last()?.message).toContain('Config polling has stopped');
    await expect(poller.ready(1_000)).rejects.toThrow('stopped');

    await advance(10 * 60_000);
    await poller.refresh();
    expect(calls).toHaveLength(5);
    expect(logs).toHaveLength(2);
  });

  test('a success resets the window', async () => {
    const { poller, errors, calls, advance } = fakeClockPoller(REFUSED_401, REFUSED_401, CONFIG_200, REFUSED_401);

    await poller.refresh(); // t = 0: the run starts
    await advance(100_000); // t = 100 s: 401, inside the window
    await advance(10_000); // t = 110 s: 200
    expect(calls).toHaveLength(3);
    expect(poller.current()).not.toBeNull();

    await advance(POLL_INTERVAL_MS); // t = 140 s: a new run of 401s starts here
    await advance(100_000); // t = 240 s: 100 s into the new run, so still retrying
    expect(calls).toHaveLength(5);
    expect(errors.last()?.message).not.toContain('stopped');

    await advance(30_000); // t = 270 s: 130 s into the run
    expect(calls).toHaveLength(6);
    expect(errors.last()?.message).toContain('Config polling has stopped');
    // The last good config is kept throughout, even after polling stops.
    expect(poller.current()?.etag).toBe('"v1"');
  });

  test('any other answer between 401s ends the run', async () => {
    const { calls, errors, advance, poller } = fakeClockPoller(
      REFUSED_401,
      { status: 500, body: { error: 'boom' } },
      REFUSED_401,
    );
    await poller.refresh(); // t = 0: 401
    await advance(100_000); // t = 100 s: 500 ends the run
    await advance(POLL_INTERVAL_MS); // t = 130 s: 401, a new run
    expect(calls).toHaveLength(3);
    expect(errors.last()?.message).not.toContain('stopped');
  });
});

describe('503 and 429', () => {
  test('503 keeps the last good config and honours Retry-After', async () => {
    const { poller, errors, calls, advance } = fakeClockPoller(
      CONFIG_200,
      { status: 503, body: { error: 'Starting up' }, headers: { 'Retry-After': '120' } },
      { status: 304 },
    );
    await poller.refresh();
    await advance(POLL_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    expect(errors.last()).toMatchObject({ kind: 'http', status: 503 });
    expect(errors.last()?.message).toContain('Retrying in 120 s');
    expect(poller.current()?.etag).toBe('"v1"');

    // Two poll intervals pass, but Retry-After asked for 120 s.
    await advance(60_000);
    await poller.refresh();
    expect(calls).toHaveLength(2);

    await advance(60_000);
    expect(calls).toHaveLength(3);
    expect(errors.last()).toBeNull();
    expect(poller.current()?.etag).toBe('"v1"');
  });

  test('a short Retry-After retries before the next poll', async () => {
    const { poller, calls, advance } = fakeClockPoller({ status: 503, headers: { 'Retry-After': '3' } }, CONFIG_200);
    await poller.refresh();
    await advance(2_000);
    expect(calls).toHaveLength(1);
    await advance(1_000);
    expect(calls).toHaveLength(2);
    expect(poller.current()).not.toBeNull();
  });

  test('429 without Retry-After waits for the next poll', async () => {
    const { poller, errors, calls, advance } = fakeClockPoller(CONFIG_200, { status: 429, body: { error: 'slow down' } });
    await poller.refresh();
    await advance(POLL_INTERVAL_MS);
    expect(calls).toHaveLength(2);
    expect(errors.last()).toMatchObject({ kind: 'rate-limited', status: 429 });
    expect(errors.last()?.message).toContain('with the next poll');

    await advance(POLL_INTERVAL_MS - 1);
    expect(calls).toHaveLength(2);
    await advance(1);
    expect(calls).toHaveLength(3);
  });

  test('with a background timer, the retry goes out when Retry-After says, not at the next poll', async () => {
    const { fetch, calls } = fakeFetch({ status: 503, headers: { 'Retry-After': '1' } }, CONFIG_200);
    const poller = createConfigPoller({
      baseUrl: 'https://t.example',
      serverKey: 'psk_live_test',
      websiteId: CONFIG.websiteId,
      fetch,
      pollIntervalMs: 60_000,
      background: true,
      errors: createErrorReporter({ now: Date.now, log: () => {} }),
      now: Date.now,
      requestTimeoutMs: 1_000,
    });
    await tick(20);
    expect(calls).toHaveLength(1);
    await tick(1_100);
    expect(calls).toHaveLength(2);
    expect(poller.current()).not.toBeNull();
    poller.close();
  });
});
