import type { Decision } from './types';
import { describe, expect, test } from 'bun:test';
import { buildSeed, serializeSeed } from './seed';

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const VISITOR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ENROL_AS = '0a1b2c3d-4e5f-8a1b-9c2d-3e4f5a6b7c8d';

const decisions: Decision[] = [
  { experimentId: 10, variantId: 102, variantKey: 'treatment', payload: null, enrolled: true },
  { experimentId: 11, variantId: 201, variantKey: 'b', payload: null, enrolled: true, enrolAs: ENROL_AS },
  { experimentId: 12, variantId: 301, variantKey: 'control', payload: null, enrolled: false, reason: 'targeting' },
  { experimentId: null, variantId: null, variantKey: null, payload: null, enrolled: false, reason: 'unknown-key' },
];

describe('buildSeed', () => {
  test('keeps enrolled decisions only, as strings, with enrolAs where set', () => {
    expect(buildSeed(decisions, VISITOR)).toEqual({
      visitorId: VISITOR,
      assignments: { '10': { variantId: '102' }, '11': { variantId: '201', enrolAs: ENROL_AS } },
    });
  });

  test('leaves visitorId out when not given', () => {
    const seed = buildSeed(decisions);
    expect('visitorId' in seed).toBe(false);
    expect(buildSeed([])).toEqual({ assignments: {} });
  });
});

describe('serializeSeed', () => {
  const hostile = {
    visitorId: `</script><script>alert(1)</script><!--&${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`,
    assignments: { '10': { variantId: '102' } },
  };

  test('escapes <, >, &, U+2028 and U+2029 as \\uXXXX', () => {
    const json = serializeSeed(hostile);
    for (const raw of ['<', '>', '&', LINE_SEPARATOR, PARAGRAPH_SEPARATOR]) {
      expect(json.includes(raw)).toBe(false);
    }
    for (const escaped of ['\\u003c', '\\u003e', '\\u0026', '\\u2028', '\\u2029']) {
      expect(json.includes(escaped)).toBe(true);
    }
  });

  test('round-trips through JSON.parse', () => {
    expect(JSON.parse(serializeSeed(hostile))).toEqual(hostile);
    const seed = buildSeed(decisions, VISITOR);
    expect(JSON.parse(serializeSeed(seed))).toEqual(seed);
  });

  test('is plain JSON.stringify when nothing needs escaping', () => {
    const seed = buildSeed(decisions, VISITOR);
    expect(serializeSeed(seed)).toBe(JSON.stringify(seed));
  });
});
