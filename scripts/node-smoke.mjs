// Runs the built package in plain Node, with no Bun and no DOM, against a stubbed fetch:
// every `decisions` and `rolloutDecisions` vector through the public API, plus the exposures
// they report, seedScript and track (with and without keys). Exits non-zero on any mismatch. This is what proves dist/ carries no Bun or DOM dependency at runtime.
//
//   bun run build && node scripts/node-smoke.mjs
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPertento } from '../dist/index.js';

const vectors = JSON.parse(readFileSync(new URL('../spec/vectors.json', import.meta.url), 'utf8'));
const config = vectors.decisionConfig;

const requests = [];
const stubFetch = async (url, init) => {
  requests.push({ url, init });
  if (url.endsWith('/sdk/config')) {
    return new Response(JSON.stringify({ ...config, salt: vectors.decisionSalt }), {
      status: 200,
      headers: { etag: '"smoke"', 'content-type': 'application/json' },
    });
  }
  if (url.endsWith('/sdk/events')) {
    return new Response(JSON.stringify({ ok: true, experimentVariantMap: { 501: '9002' } }), { status: 200 });
  }
  if (url.endsWith('/sdk/exposures')) {
    const { exposures } = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, accepted: exposures.length }), { status: 200 });
  }
  return new Response('{"error":"not found"}', { status: 404 });
};

const exposuresSent = () =>
  requests
    .filter(({ url }) => url === 'https://tracking.example.test/sdk/exposures')
    .flatMap(({ init }) => JSON.parse(init.body).exposures);

const pertento = createPertento({
  websiteId: config.websiteId,
  serverKey: 'psk_live_test_00000000000000000000000000000000000000',
  baseUrl: 'https://tracking.example.test/',
  fetch: stubFetch,
});
await pertento.ready();

let failures = 0;
for (const { name, input, expected } of vectors.decisions) {
  const { key, ...identity } = input;
  const actual = await pertento.getVariant(key, identity);
  try {
    deepStrictEqual(actual, expected);
  } catch {
    failures += 1;
    console.error(`MISMATCH ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}

// Every enrolled decision, and every deployed one, is reported once per experiment and
// enrolment ID, in the order decided.
await pertento.flush();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const experimentById = new Map(config.experiments.map((experiment) => [experiment.id, experiment]));
/** The deployed variant of a Deployed visitor experiment, decided for a valid visitor ID. */
const isDeployedVisitorDecision = (input, expected) => {
  const experiment = experimentById.get(expected.experimentId);
  if (experiment?.status !== 'Deployed' || expected.variantId !== experiment.deployedVariantId) return false;
  // The vectors deploy no customer ID experiment; its ID would have to be derived here.
  strictEqual(experiment.bucketOn, 'visitor');
  return UUID.test(input.visitorId ?? '');
};
const expectedExposures = new Map();
let deployedReported = 0;
for (const { input, expected } of vectors.decisions) {
  const deployed = !expected.enrolled && isDeployedVisitorDecision(input, expected);
  if (!expected.enrolled && !deployed) continue;
  if (deployed) deployedReported += 1;
  const enrolAs = expected.enrolAs ?? input.visitorId.toLowerCase();
  const pair = `${expected.experimentId}:${enrolAs}`;
  if (!expectedExposures.has(pair)) {
    expectedExposures.set(pair, { experimentId: expected.experimentId, variantId: expected.variantId, enrolAs });
  }
}
ok(expectedExposures.size > 0, 'the vectors enrol someone');
ok(deployedReported > 0, 'the vectors serve a deployed variant');
deepStrictEqual(exposuresSent(), [...expectedExposures.values()]);

const visitorId = pertento.createVisitorId();
ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(visitorId), 'createVisitorId');
const all = await pertento.getAll({ visitorId });
const script = pertento.seedScript(all, visitorId);
ok(script.startsWith('<script>window.PertentoSeed=') && script.endsWith(';</script>'), 'seedScript shape');
// The seeded page enrols these decisions itself, so the client does not report them. The seed
// carries no deployed decision, so those are still reported.
const reportedBeforeSeed = exposuresSent().length;
await pertento.flush();
const deployedForVisitor = Object.values(all).filter(({ experimentId, variantId }) => {
  const experiment = experimentById.get(experimentId);
  return experiment?.status === 'Deployed' && variantId === experiment.deployedVariantId;
});
ok(deployedForVisitor.length > 0, 'getAll serves a deployed variant');
deepStrictEqual(
  exposuresSent().slice(reportedBeforeSeed),
  deployedForVisitor.map(({ experimentId, variantId }) => ({ experimentId, variantId, enrolAs: visitorId })),
);

const keys = Object.keys(all);
const tracked = await pertento.track('purchase', { keys, visitorId, data: { revenue: 4900 } });
deepStrictEqual(tracked, { ok: true, experimentVariantMap: { 501: '9002' } });
const trackRequest = requests.find(({ url }) => url === 'https://tracking.example.test/sdk/events');
deepStrictEqual(JSON.parse(trackRequest.init.body), {
  events: [{ name: 'purchase', data: { revenue: 4900 } }],
  keys,
  visitorId,
});
strictEqual(pertento.lastError, null);

// Without keys nothing is sent: the result is ok: false and the reason is in lastError.
const sentBefore = requests.length;
const originalError = console.error;
console.error = () => {};
const refused = await pertento.track('purchase', { visitorId });
console.error = originalError;
strictEqual(refused.ok, false);
strictEqual(requests.length, sentBefore);
strictEqual(pertento.lastError?.kind, 'bad-request');
await pertento.close();

// The feature-flag vectors, against their own version 2 config.
const flagFetch = async (url) => {
  if (url.endsWith('/sdk/config')) {
    return new Response(JSON.stringify({ ...vectors.rolloutConfig, salt: vectors.decisionSalt }), {
      status: 200,
      headers: { etag: '"smoke-flags"', 'content-type': 'application/json' },
    });
  }
  if (url.endsWith('/sdk/exposures')) return new Response('{"ok":true,"accepted":1}', { status: 200 });
  return new Response('{"error":"not found"}', { status: 404 });
};
const flags = createPertento({
  websiteId: vectors.rolloutConfig.websiteId,
  serverKey: 'psk_live_test_00000000000000000000000000000000000000',
  baseUrl: 'https://tracking.example.test/',
  fetch: flagFetch,
});
ok(await flags.ready(), 'a version 2 config is accepted');
for (const { name, input, expected } of vectors.rolloutDecisions) {
  const { key, ...identity } = input;
  const actual = await flags.getVariant(key, identity);
  try {
    deepStrictEqual(actual, expected);
  } catch {
    failures += 1;
    console.error(`MISMATCH ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
}
await flags.close();
strictEqual(flags.lastError, null);

const total = vectors.decisions.length + vectors.rolloutDecisions.length;
if (failures > 0) {
  console.error(`node smoke: ${failures} of ${total} decision vectors failed`);
  process.exit(1);
}
console.log(`node smoke (${process.version}): ${total} decision vectors, exposures, seedScript and track passed`);
