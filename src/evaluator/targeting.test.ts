import type { AttributeRule } from './types';
import { describe, expect, test } from 'bun:test';
import { matchAttributeRules } from './targeting';

const rule = (operator: AttributeRule['operator'], value?: AttributeRule['value']): AttributeRule =>
  value === undefined ? { attribute: 'x', operator } : { attribute: 'x', operator, value };

const matches = (r: AttributeRule, x: unknown): boolean => matchAttributeRules([r], { x });
const matchesMissing = (r: AttributeRule): boolean => matchAttributeRules([r], {});

describe('matchAttributeRules', () => {
  test('no rules match everyone, with or without attributes', () => {
    expect(matchAttributeRules([], undefined)).toBe(true);
    expect(matchAttributeRules([], { plan: 'pro' })).toBe(true);
  });

  test('rules are ANDed', () => {
    const rules: AttributeRule[] = [
      { attribute: 'plan', operator: 'equals', value: 'pro' },
      { attribute: 'age', operator: '>', value: 18 },
    ];
    expect(matchAttributeRules(rules, { plan: 'pro', age: 30 })).toBe(true);
    expect(matchAttributeRules(rules, { plan: 'pro', age: 10 })).toBe(false);
    expect(matchAttributeRules(rules, { plan: 'free', age: 30 })).toBe(false);
  });

  describe('equals', () => {
    test('matches the same value and type', () => {
      expect(matches(rule('equals', 'pro'), 'pro')).toBe(true);
      expect(matches(rule('equals', 3), 3)).toBe(true);
      expect(matches(rule('equals', true), true)).toBe(true);
    });
    test('is strict on type and case', () => {
      expect(matches(rule('equals', 3), '3')).toBe(false);
      expect(matches(rule('equals', '3'), 3)).toBe(false);
      expect(matches(rule('equals', true), 'true')).toBe(false);
      expect(matches(rule('equals', 'Pro'), 'pro')).toBe(false);
    });
    test('never matches arrays, objects, non-finite numbers or a missing attribute', () => {
      expect(matches(rule('equals', ['a']), ['a'])).toBe(false);
      expect(matches(rule('equals', 'a'), ['a'])).toBe(false);
      expect(matches(rule('equals', 'a'), { a: 1 })).toBe(false);
      expect(matches(rule('equals', Number.NaN), Number.NaN)).toBe(false);
      expect(matches(rule('equals', Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY)).toBe(false);
      expect(matchesMissing(rule('equals', 'a'))).toBe(false);
    });
  });

  describe('in', () => {
    test('matches a string or number in the list, strictly', () => {
      expect(matches(rule('in', ['se', 'no']), 'se')).toBe(true);
      expect(matches(rule('in', [1, 2]), 2)).toBe(true);
      expect(matches(rule('in', [1, 2]), '2')).toBe(false);
      expect(matches(rule('in', ['se']), 'SE')).toBe(false);
    });
    test('a non-array value, a boolean, an array or a missing attribute never matches', () => {
      expect(matches(rule('in', 'se'), 'se')).toBe(false);
      expect(matches({ attribute: 'x', operator: 'in', value: [true] } as unknown as AttributeRule, true)).toBe(false);
      expect(matches(rule('in', ['se']), ['se'])).toBe(false);
      expect(matchesMissing(rule('in', ['se']))).toBe(false);
    });
  });

  describe('not in', () => {
    test('matches a string or number absent from the list', () => {
      expect(matches(rule('not in', ['se', 'no']), 'dk')).toBe(true);
      expect(matches(rule('not in', ['se', 'no']), 'se')).toBe(false);
      expect(matches(rule('not in', [1]), '1')).toBe(true);
    });
    test('a missing or null attribute does not match', () => {
      expect(matchesMissing(rule('not in', ['se']))).toBe(false);
      expect(matches(rule('not in', ['se']), null)).toBe(false);
    });
    test('a non-array value or a wrongly typed attribute does not match', () => {
      expect(matches(rule('not in', 'se'), 'dk')).toBe(false);
      expect(matches(rule('not in', ['se']), true)).toBe(false);
      expect(matches(rule('not in', ['se']), ['dk'])).toBe(false);
    });
  });

  describe('< and >', () => {
    test('compare finite numbers', () => {
      expect(matches(rule('<', 10), 9)).toBe(true);
      expect(matches(rule('<', 10), 10)).toBe(false);
      expect(matches(rule('>', 10), 11)).toBe(true);
      expect(matches(rule('>', 10), 10)).toBe(false);
      expect(matches(rule('>', -1.5), 0)).toBe(true);
    });
    test('never coerce strings and never match non-finite numbers', () => {
      expect(matches(rule('<', 10), '9')).toBe(false);
      expect(matches(rule('>', '10'), 11)).toBe(false);
      expect(matches(rule('<', 10), Number.NEGATIVE_INFINITY)).toBe(false);
      expect(matches(rule('>', 10), Number.NaN)).toBe(false);
      expect(matchesMissing(rule('<', 10))).toBe(false);
    });
  });

  describe('exists', () => {
    test('matches any present non-null value and ignores value', () => {
      expect(matches(rule('exists'), 'a')).toBe(true);
      expect(matches(rule('exists'), 0)).toBe(true);
      expect(matches(rule('exists'), false)).toBe(true);
      expect(matches(rule('exists'), '')).toBe(true);
      expect(matches(rule('exists', 'ignored'), 'other')).toBe(true);
    });
    test('null, undefined and missing are absent', () => {
      expect(matches(rule('exists'), null)).toBe(false);
      expect(matches(rule('exists'), undefined)).toBe(false);
      expect(matchesMissing(rule('exists'))).toBe(false);
    });
    test('reads own properties only', () => {
      expect(matchAttributeRules([{ attribute: 'toString', operator: 'exists' }], {})).toBe(false);
      expect(matchAttributeRules([{ attribute: '__proto__', operator: 'exists' }], {})).toBe(false);
    });
  });

  test('malformed rules and attributes never throw and never match', () => {
    const malformed = [
      null,
      'equals',
      { operator: 'exists' },
      { attribute: 'x', operator: 'contains', value: 'a' },
      { attribute: 3, operator: 'exists' },
    ] as unknown as AttributeRule[];
    for (const r of malformed) {
      expect(matchAttributeRules([r], { x: 'a' })).toBe(false);
    }
    expect(matchAttributeRules('nope' as unknown as AttributeRule[], {})).toBe(false);
    expect(matchAttributeRules([rule('exists')], 'nope' as unknown as Record<string, unknown>)).toBe(false);
  });
});
