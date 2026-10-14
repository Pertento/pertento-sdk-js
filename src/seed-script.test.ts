import type { Decision } from './evaluator';
import { describe, expect, test } from 'bun:test';
import { serializeSeed } from './evaluator';
import { seedScript } from './seed-script';

const VISITOR = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const decisions: Decision[] = [
  { experimentId: 501, variantId: 9002, variantKey: 'one-page', payload: { layout: 'single' }, enrolled: true },
  { experimentId: 503, variantId: 9021, variantKey: 'off', payload: false, enrolled: false, reason: 'targeting' },
];

describe('seedScript', () => {
  test('wraps the inline-safe seed in a script element', () => {
    expect(seedScript(decisions, VISITOR)).toBe(
      `<script>window.PertentoSeed={"visitorId":"${VISITOR}","assignments":{"501":{"variantId":"9002"}}};</script>`,
    );
  });

  test('takes getAll()\'s record as well as a list', () => {
    expect(seedScript({ a: decisions[0]!, b: decisions[1]! }, VISITOR)).toBe(seedScript(decisions, VISITOR));
  });

  test('a hostile visitor ID cannot close the element', () => {
    const hostile = '</script><script>alert(1)</script>';
    const html = seedScript(decisions, hostile);
    expect(html.indexOf('</script>')).toBe(html.length - '</script>'.length);
    expect(html).toContain(serializeSeed({ visitorId: hostile, assignments: { '501': { variantId: '9002' } } }));
  });

  test('writes an escaped CSP nonce attribute', () => {
    expect(seedScript([], undefined, { nonce: 'abc123' })).toBe(
      '<script nonce="abc123">window.PertentoSeed={"assignments":{}};</script>',
    );
    expect(seedScript([], undefined, { nonce: '"><b>' })).toStartWith('<script nonce="&#34;&#62;&#60;b&#62;">');
  });
});
