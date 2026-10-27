import type { Decision, SdkConfig } from './evaluator';
import type { FakeCall, FakeReply } from '../test/fake-fetch';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import rawVectors from '../spec/vectors.json';
import { fakeFetch, hangingFetch, tick } from '../test/fake-fetch';
import { createPertento } from './client';
import { createErrorReporter } from './errors';
import { deriveEnrolmentId } from './evaluator';
import { createExposureReporter, MAX_EXPOSURES_PER_REQUEST, REPORTED_EXPOSURES_LIMIT } from './exposures';
import { seedScript } from './seed-script';

const vectors = rawVectors as unknown as { decisionConfig: SdkConfig; decisionSalt: string };
const CONFIG = vectors.decisionConfig;
const SALT = vectors.decisionSalt;
const KEY = 'psk_live_test_00000000000000000000000000000000000000';
const VISITOR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ACCEPTED: FakeReply = { status: 200, body: { ok: true, accepted: 1 } };

/** The nth visitor ID, a valid lowercase UUID. */
const visitor = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const enrolled = (experimentId: number, variantId = 1, enrolAs?: string): Decision =>
  enrolAs === undefined
    ? { experimentId, variantId, variantKey: 'b', payload: null, enrolled: true }
    : { experimentId, variantId, variantKey: 'b', payload: null, enrolled: true, enrolAs };

const bodyOf = (call: FakeCall): unknown => JSON.parse(call.init.body ?? 'null');
const exposuresOf = (call: FakeCall): Array<{ experimentId: number; variantId: number; enrolAs: string }> =>
  (bodyOf(call) as { exposures: Array<{ experimentId: number; variantId: number; enrolAs: string }> }).exposures;

type ReporterOptions = { background?: boolean; enabled?: boolean; flushIntervalMs?: number; reportedLimit?: number };

/** A reporter on its own, answering every send from `script`. */
function reporter(options: ReporterOptions = {}, ...script: Parameters<typeof fakeFetch>) {
  const logs: string[] = [];
  const { fetch, calls } = fakeFetch(...(script.length > 0 ? script : [ACCEPTED]));
  const errors = createErrorReporter({ now: Date.now, log: (line) => logs.push(line) });
  const exposures = createExposureReporter({
    baseUrl: 'https://t.example',
    serverKey: KEY,
    fetch,
    errors,
    background: options.background ?? false,
    enabled: options.enabled ?? true,
    ...(options.flushIntervalMs === undefined ? {} : { flushIntervalMs: options.flushIntervalMs }),
    ...(options.reportedLimit === undefined ? {} : { reportedLimit: options.reportedLimit }),
  });
  const sent = () => calls.flatMap(exposuresOf);
  return { exposures, errors, calls, logs, sent };
}

type ClientOptions = { background?: boolean; exposures?: boolean };

/** A client on the vectors' config; exposure requests get `reply`. */
function client(options: ClientOptions = {}, reply: FakeReply | ((call: FakeCall) => Promise<FakeReply>) = ACCEPTED) {
  const { fetch, calls } = fakeFetch((call) => {
    if (call.url.endsWith('/sdk/config')) return { status: 200, body: { ...CONFIG, salt: SALT }, headers: { ETag: '"v1"' } };
    if (call.url.endsWith('/sdk/events')) return { status: 200, body: { ok: true, experimentVariantMap: {} } };
    return typeof reply === 'function' ? reply(call) : reply;
  });
  const pertento = createPertento({
    websiteId: CONFIG.websiteId,
    serverKey: KEY,
    baseUrl: 'https://t.example/',
    fetch,
    background: options.background ?? false,
    ...(options.exposures === undefined ? {} : { exposures: options.exposures }),
  });
  const exposureCalls = () => calls.filter(({ url }) => url.endsWith('/sdk/exposures'));
  const sent = () => exposureCalls().flatMap(exposuresOf);
  return { pertento, calls, exposureCalls, sent };
}

let consoleError: ReturnType<typeof spyOn>;
beforeEach(() => {
  consoleError = spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

describe('what is recorded', () => {
  test('POSTs /sdk/exposures with the key and the exposures, enrolAs first, else the visitor ID', async () => {
    const { exposures, calls } = reporter();
    const enrolAs = await deriveEnrolmentId({ salt: SALT, customerId: 'Cust-1' });
    exposures.record([enrolled(501, 9002), enrolled(502, 9012, enrolAs)], VISITOR);
    await exposures.flush();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe('https://t.example/sdk/exposures');
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(call!.init.headers['content-type']).toBe('application/json');
    expect(bodyOf(call!)).toEqual({
      exposures: [
        { experimentId: 501, variantId: 9002, enrolAs: VISITOR },
        { experimentId: 502, variantId: 9012, enrolAs },
      ],
    });
  });

  test('leaves out decisions that are not enrolled, and enrolled ones with no enrolment ID', async () => {
    const { exposures, calls } = reporter();
    exposures.record(
      [{ experimentId: 503, variantId: 9021, variantKey: 'off', payload: false, enrolled: false, reason: 'targeting' }],
      VISITOR,
    );
    exposures.record([enrolled(501)], undefined);
    exposures.record([enrolled(501)], 'not-a-uuid');
    await exposures.flush();
    expect(calls).toHaveLength(0);
  });

  test('through the client: getVariant and getAll report enrolled decisions, the visitor ID lowercased', async () => {
    const { pertento, sent } = client();
    await pertento.ready();
    await pertento.getVariant('new-checkout', { visitorId: VISITOR.toUpperCase() });
    const all = await pertento.getAll({ visitorId: visitor(1), id: 'Cust-1' });
    await pertento.flush();

    const expected = Object.values(all)
      .filter((decision) => decision.enrolled)
      .map((decision) => ({
        experimentId: decision.experimentId,
        variantId: decision.variantId,
        enrolAs: decision.enrolled ? (decision.enrolAs ?? visitor(1)) : '',
      }));
    const checkout = await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    expect(sent()).toEqual([{ experimentId: 501, variantId: checkout.variantId!, enrolAs: VISITOR }, ...expected]);
    // A customer ID experiment enrols as the derived ID, never the customer ID itself.
    const pricing = sent().find(({ experimentId }) => experimentId === 502);
    expect(pricing?.enrolAs).toBe(await deriveEnrolmentId({ salt: SALT, customerId: 'Cust-1' }));
    expect(JSON.stringify(sent())).not.toContain('Cust-1');
    await pertento.close();
  });
});

describe('dedupe', () => {
  test('each experiment and enrolment ID pair is sent once per client', async () => {
    const { exposures, sent } = reporter();
    exposures.record([enrolled(501, 9002)], VISITOR);
    exposures.record([enrolled(501, 9002)], VISITOR);
    await exposures.flush();
    // Sent already, and a later variant for the same pair is the same enrolment to the server.
    exposures.record([enrolled(501, 9001)], VISITOR);
    exposures.record([enrolled(502, 9012)], VISITOR);
    exposures.record([enrolled(501, 9002)], visitor(2));
    await exposures.flush();
    expect(sent()).toEqual([
      { experimentId: 501, variantId: 9002, enrolAs: VISITOR },
      { experimentId: 502, variantId: 9012, enrolAs: VISITOR },
      { experimentId: 501, variantId: 9002, enrolAs: visitor(2) },
    ]);
  });

  test('remembers a bounded number of pairs, forgetting the one seen longest ago', async () => {
    const { exposures, sent } = reporter({ reportedLimit: 3 });
    for (const n of [1, 2, 3]) exposures.record([enrolled(501)], visitor(n));
    // Seeing visitor 1 again makes visitor 2 the one seen longest ago.
    exposures.record([enrolled(501)], visitor(1));
    exposures.record([enrolled(501)], visitor(4));
    await exposures.flush();
    expect(sent().map(({ enrolAs }) => enrolAs)).toEqual([visitor(1), visitor(2), visitor(3), visitor(4)]);

    // Visitors 3, 1 and 4 are remembered; visitor 2 was forgotten and is sent again.
    for (const n of [3, 1, 4, 2]) exposures.record([enrolled(501)], visitor(n));
    await exposures.flush();
    expect(sent().map(({ enrolAs }) => enrolAs).slice(4)).toEqual([visitor(2)]);
  });

  test(`holds ${REPORTED_EXPOSURES_LIMIT} pairs by default`, async () => {
    const { exposures, sent } = reporter();
    for (let n = 0; n <= REPORTED_EXPOSURES_LIMIT; n += 1) exposures.record([enrolled(501)], visitor(n));
    await exposures.flush();
    expect(sent()).toHaveLength(REPORTED_EXPOSURES_LIMIT + 1);

    exposures.record([enrolled(501)], visitor(REPORTED_EXPOSURES_LIMIT));
    exposures.record([enrolled(501)], visitor(0));
    await exposures.flush();
    expect(sent().slice(REPORTED_EXPOSURES_LIMIT + 1)).toEqual([{ experimentId: 501, variantId: 1, enrolAs: visitor(0) }]);
  });
});

describe('batching', () => {
  test(`${MAX_EXPOSURES_PER_REQUEST} queued are sent at once, without a flush or a timer`, async () => {
    const { exposures, calls } = reporter();
    for (let n = 1; n < MAX_EXPOSURES_PER_REQUEST; n += 1) exposures.record([enrolled(501)], visitor(n));
    expect(calls).toHaveLength(0);
    exposures.record([enrolled(501)], visitor(MAX_EXPOSURES_PER_REQUEST));
    expect(calls).toHaveLength(1);
    expect(exposuresOf(calls[0]!)).toHaveLength(MAX_EXPOSURES_PER_REQUEST);
    await exposures.flush();
    expect(calls).toHaveLength(1);
  });

  test(`no request carries more than ${MAX_EXPOSURES_PER_REQUEST}`, async () => {
    const { exposures, calls } = reporter();
    const decisions = Array.from({ length: 250 }, (_, index) => enrolled(index + 1));
    exposures.record(decisions, VISITOR);
    await exposures.flush();
    expect(calls.map((call) => exposuresOf(call).length)).toEqual([100, 100, 50]);
  });

  test('in the background, a timer sends the queue', async () => {
    const { exposures, calls } = reporter({ background: true, flushIntervalMs: 20 });
    exposures.record([enrolled(501)], VISITOR);
    exposures.record([enrolled(502)], VISITOR);
    await tick(5);
    expect(calls).toHaveLength(0);
    await tick(40);
    expect(calls).toHaveLength(1);
    expect(exposuresOf(calls[0]!)).toHaveLength(2);
    // Nothing queued, nothing sent.
    await tick(40);
    expect(calls).toHaveLength(1);
    await exposures.close();
  });

  test('the timer is unref\'d, so it never keeps a process alive', async () => {
    const handles: Array<{ hasRef?: () => boolean }> = [];
    const original = globalThis.setTimeout;
    const spy = spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const handle = original(...args);
      handles.push(handle as unknown as { hasRef?: () => boolean });
      return handle;
    }) as typeof setTimeout);
    try {
      const { exposures } = reporter({ background: true });
      exposures.record([enrolled(501)], VISITOR);
      expect(handles).toHaveLength(1);
      expect(handles[0]!.hasRef?.()).toBe(false);
      await exposures.close();
    } finally {
      spy.mockRestore();
    }
  });

  test('with background: false, the next getVariant, getAll or track sends the queue without waiting for it', async () => {
    for (const next of ['getVariant', 'getAll', 'track'] as const) {
      const { pertento, exposureCalls } = client({ background: false });
      await pertento.ready();
      await pertento.getVariant('new-checkout', { visitorId: VISITOR });
      await tick(10);
      expect(exposureCalls()).toHaveLength(0);

      if (next === 'getVariant') await pertento.getVariant('pro-banner', { visitorId: VISITOR });
      if (next === 'getAll') await pertento.getAll({});
      if (next === 'track') await pertento.track('purchase', { keys: ['new-checkout'], visitorId: VISITOR });
      expect(exposureCalls()).toHaveLength(1);
      expect(exposuresOf(exposureCalls()[0]!)).toEqual([{ experimentId: 501, variantId: expect.any(Number), enrolAs: VISITOR }]);
    }
  });
});

describe('flush() and close()', () => {
  test('flush() resolves once the queued batch and any batch already on its way are answered', async () => {
    const answers: Array<() => void> = [];
    const { exposures, calls } = reporter(
      {},
      () =>
        new Promise<FakeReply>((resolve) => {
          answers.push(() => resolve(ACCEPTED));
        }),
    );
    for (let n = 1; n <= MAX_EXPOSURES_PER_REQUEST; n += 1) exposures.record([enrolled(501)], visitor(n));
    exposures.record([enrolled(502)], VISITOR);

    let flushed = false;
    const flushing = exposures.flush().then(() => {
      flushed = true;
    });
    await tick();
    expect(calls).toHaveLength(2);
    answers[1]?.();
    await tick();
    expect(flushed).toBe(false);
    answers[0]?.();
    await flushing;
    expect(flushed).toBe(true);
  });

  test('flush() with nothing queued resolves at once and sends nothing', async () => {
    const { exposures, calls } = reporter();
    await exposures.flush();
    expect(calls).toHaveLength(0);
  });

  test('close() sends the queue and stops the timer; later exposures wait for the next call', async () => {
    const { exposures, calls } = reporter({ background: true, flushIntervalMs: 20 });
    exposures.record([enrolled(501)], VISITOR);
    await exposures.close();
    expect(calls).toHaveLength(1);

    exposures.record([enrolled(502)], VISITOR);
    await tick(50);
    expect(calls).toHaveLength(1);
    exposures.onCall();
    expect(calls).toHaveLength(2);
    await exposures.flush();
  });

  test('client.close() sends what getVariant queued, and resolves when it is sent', async () => {
    const { pertento, exposureCalls } = client({ background: true });
    await pertento.ready();
    await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    expect(exposureCalls()).toHaveLength(0);
    await pertento.close();
    expect(exposureCalls()).toHaveLength(1);
    expect(pertento.lastError).toBeNull();
  });
});

describe('seeded decisions', () => {
  test('client.seedScript takes its decisions out of the queue and never reports them later', async () => {
    const { pertento, exposureCalls } = client();
    await pertento.ready();
    const decision = await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    pertento.seedScript([decision], VISITOR);
    await pertento.flush();
    await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    await pertento.flush();
    expect(exposureCalls()).toHaveLength(0);
  });

  test('a seed built before the decision is reported keeps it from being queued', async () => {
    const { pertento, sent } = client();
    await pertento.ready();
    const decisions = await pertento.getAll({ visitorId: VISITOR, id: 'Cust-1' });
    pertento.seedScript(decisions, VISITOR);
    // The same person on a later request, decided again, is not reported: the page enrolled them.
    await pertento.getAll({ visitorId: VISITOR, id: 'Cust-1' });
    // Someone else is.
    await pertento.getVariant('new-checkout', { visitorId: visitor(7) });
    await pertento.flush();
    expect(sent()).toEqual([{ experimentId: 501, variantId: expect.any(Number), enrolAs: visitor(7) }]);
  });

  test('a seed without a visitor ID still cancels the decisions it carries', async () => {
    const { pertento, exposureCalls } = client();
    await pertento.ready();
    const decision = await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    pertento.seedScript([decision]);
    await pertento.flush();
    expect(exposureCalls()).toHaveLength(0);
  });

  test('only the enrolled decisions in the seed are cancelled', async () => {
    const { pertento, sent } = client();
    await pertento.ready();
    await pertento.getVariant('pricing-page', { id: 'Cust-1' });
    const banner = await pertento.getVariant('pro-banner', { visitorId: VISITOR });
    // Decided last, so no later call has sent it before the seed is built.
    const checkout = await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    expect(banner.enrolled).toBe(false);
    pertento.seedScript([checkout, banner], VISITOR);
    await pertento.flush();
    expect(sent().map(({ experimentId }) => experimentId)).toEqual([502]);
  });

  // The race the README describes: a batch that went out before the seed was built is not
  // called back, so the browser counts that decision as well (the server dedupes its own side).
  test('a decision already sent when the seed is built stays sent', async () => {
    const { pertento, sent } = client({ background: false });
    await pertento.ready();
    const checkout = await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    const pricing = await pertento.getVariant('pricing-page', { id: 'Cust-1' });
    // The second call sent the first decision before the seed below existed.
    pertento.seedScript([checkout, pricing], VISITOR);
    await pertento.flush();
    expect(sent().map(({ experimentId }) => experimentId)).toEqual([501]);
  });

  test('the standalone seedScript export stays pure: the client still reports', async () => {
    const { pertento, exposureCalls } = client();
    await pertento.ready();
    const decision = await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    expect(seedScript([decision], VISITOR)).toBe(pertento.seedScript([decision], VISITOR));
    const other = await pertento.getVariant('new-checkout', { visitorId: visitor(3) });
    seedScript([other], visitor(3));
    await pertento.flush();
    expect(exposureCalls().flatMap(exposuresOf)).toEqual([{ experimentId: 501, variantId: other.variantId!, enrolAs: visitor(3) }]);
  });
});

describe('opting out', () => {
  test('exposures: false records and sends nothing', async () => {
    const { pertento, exposureCalls } = client({ exposures: false, background: false });
    await pertento.ready();
    await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    await pertento.getAll({ visitorId: visitor(2), id: 'Cust-1' });
    await pertento.getVariant('new-checkout', { visitorId: visitor(3) });
    await pertento.flush();
    await pertento.close();
    expect(exposureCalls()).toHaveLength(0);
  });

  test('a disabled reporter sends nothing however much is recorded', async () => {
    const { exposures, calls } = reporter({ enabled: false });
    for (let n = 0; n < 2 * MAX_EXPOSURES_PER_REQUEST; n += 1) exposures.record([enrolled(501)], visitor(n));
    exposures.onCall();
    await exposures.flush();
    expect(calls).toHaveLength(0);
  });
});

describe('failures', () => {
  test.each([
    ['a refusal', { status: 429, body: { error: 'Too many requests' } }, 'rate-limited'],
    ['a server error', { status: 503, body: { error: 'starting' } }, 'http'],
    ['a network failure', new TypeError('fetch failed'), 'network'],
  ] as const)('%s drops the batch, never throws, and is logged once per kind', async (_, reply, kind) => {
    const { exposures, errors, calls, logs } = reporter({}, reply);
    exposures.record([enrolled(501)], VISITOR);
    await exposures.flush();
    exposures.record([enrolled(502)], VISITOR);
    await exposures.flush();

    expect(calls).toHaveLength(2);
    expect(errors.last()).toMatchObject({ source: 'exposures', kind });
    expect(errors.last()?.message).toContain('not retried');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith('[pertento] exposures:');

    // Dropped means dropped: the pairs are not queued again.
    exposures.record([enrolled(501), enrolled(502)], VISITOR);
    await exposures.flush();
    expect(calls).toHaveLength(2);
  });

  test('times out once, with no retry', async () => {
    const { fetch, calls } = hangingFetch();
    const errors = createErrorReporter({ now: Date.now, log: () => {} });
    const exposures = createExposureReporter({
      baseUrl: 'https://t.example',
      serverKey: KEY,
      fetch,
      errors,
      background: false,
      enabled: true,
      requestTimeoutMs: 20,
    });
    exposures.record([enrolled(501)], VISITOR);
    await exposures.flush();
    expect(calls).toHaveLength(1);
    expect(errors.last()).toMatchObject({ source: 'exposures', kind: 'timeout' });
  });

  test('a later success clears an exposures error', async () => {
    const { exposures, errors } = reporter({}, { status: 500, body: { error: 'boom' } }, ACCEPTED);
    exposures.record([enrolled(501)], VISITOR);
    await exposures.flush();
    expect(errors.last()).toMatchObject({ source: 'exposures', kind: 'http', status: 500 });
    exposures.record([enrolled(502)], VISITOR);
    await exposures.flush();
    expect(errors.last()).toBeNull();
  });

  test('through the client: a down server never reaches the caller, and decisions still answer', async () => {
    const { pertento, exposureCalls } = client({ background: false }, { status: 502, body: { error: 'bad gateway' } });
    await pertento.ready();
    for (const n of [1, 2, 3]) {
      expect((await pertento.getVariant('new-checkout', { visitorId: visitor(n) })).enrolled).toBe(true);
    }
    await pertento.flush();
    // Each call sent the one before it, and flush() the last: three refusals, one log line.
    expect(exposureCalls()).toHaveLength(3);
    expect(pertento.lastError).toMatchObject({ source: 'exposures', kind: 'http', status: 502 });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});

describe('decisions never wait for the network', () => {
  test('a decision resolves before its exposure is sent, and while a send hangs', async () => {
    const { pertento, calls, exposureCalls } = client({ background: true }, () => new Promise<FakeReply>(() => {}));
    await pertento.ready();
    const before = calls.length;
    const decision = await pertento.getVariant('new-checkout', { visitorId: VISITOR });
    expect(decision.enrolled).toBe(true);
    expect(calls).toHaveLength(before);

    // 100 queued start a send that never answers; the decisions around it still resolve.
    const all = await Promise.all(
      Array.from({ length: MAX_EXPOSURES_PER_REQUEST + 5 }, (_, n) =>
        pertento.getVariant('new-checkout', { visitorId: visitor(n + 1) }),
      ),
    );
    expect(all.every(({ enrolled: isEnrolled }) => isEnrolled)).toBe(true);
    expect(exposureCalls()).toHaveLength(1);
  });

  test('record() only touches memory, even when fetch throws synchronously', async () => {
    const errors = createErrorReporter({ now: Date.now, log: () => {} });
    const exposures = createExposureReporter({
      baseUrl: 'https://t.example',
      serverKey: KEY,
      fetch: () => {
        throw new Error('sync throw');
      },
      errors,
      background: false,
      enabled: true,
    });
    const decisions = Array.from({ length: MAX_EXPOSURES_PER_REQUEST }, (_, n) => enrolled(n + 1));
    expect(() => exposures.record(decisions, VISITOR)).not.toThrow();
    await exposures.flush();
    expect(errors.last()).toMatchObject({ source: 'exposures', kind: 'network' });
  });
});
