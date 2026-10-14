// Runs the built package in plain Node, with no Bun and no DOM, against a stubbed fetch:
// every `decisions` vector through the public API, plus seedScript and track. Exits non-zero
// on any mismatch. This is what proves dist/ carries no Bun or DOM dependency at runtime.
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
  return new Response('{"error":"not found"}', { status: 404 });
};

const pertento = createPertento({
  websiteId: config.websiteId,
  serverKey: 'psk_live_smoke',
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

const visitorId = pertento.createVisitorId();
ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(visitorId), 'createVisitorId');
const all = await pertento.getAll({ visitorId });
const script = pertento.seedScript(all, visitorId);
ok(script.startsWith('<script>window.PertentoSeed=') && script.endsWith(';</script>'), 'seedScript shape');

const tracked = await pertento.track('purchase', { visitorId, data: { revenue: 4900 } });
deepStrictEqual(tracked, { ok: true, experimentVariantMap: { 501: '9002' } });
const trackRequest = requests.find(({ url }) => url === 'https://tracking.example.test/sdk/events');
deepStrictEqual(JSON.parse(trackRequest.init.body), { events: [{ name: 'purchase', data: { revenue: 4900 } }], visitorId });
strictEqual(pertento.lastError, null);
pertento.close();

if (failures > 0) {
  console.error(`node smoke: ${failures} of ${vectors.decisions.length} decision vectors failed`);
  process.exit(1);
}
console.log(`node smoke (${process.version}): ${vectors.decisions.length} decision vectors, seedScript and track passed`);
