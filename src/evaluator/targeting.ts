import type { AttributeRule, Attributes } from './types';

type Scalar = string | number | boolean;

/**
 * True when every rule matches (AND); an empty rule list matches everyone.
 *
 * Never throws. A rule or attribute of the wrong type is a non-match, never an error:
 * the rules come from our database and the attributes from the customer's code, and
 * a typo in either must cost an enrolment, not the customer's request.
 * The full semantics are in spec/SPEC.md, "Attribute rules".
 */
export function matchAttributeRules(rules: readonly AttributeRule[], attributes: Attributes | undefined): boolean {
  if (!Array.isArray(rules)) return false;
  return rules.every((rule) => matchRule(rule, attributes ?? {}));
}

function matchRule(rule: unknown, attributes: Attributes): boolean {
  if (!isRecord(rule) || typeof rule['attribute'] !== 'string') return false;
  const actual = readAttribute(attributes, rule['attribute']);
  const expected = rule['value'];

  switch (rule['operator']) {
    case 'exists':
      return actual !== undefined;
    case 'equals':
      return isScalar(actual) && isScalar(expected) && actual === expected;
    case 'in':
      return isListable(actual) && Array.isArray(expected) && expected.includes(actual);
    case 'not in':
      // A missing attribute is not "not in" the list: it does not match, like every
      // other operator but 'exists'. See spec/SPEC.md for why.
      return isListable(actual) && Array.isArray(expected) && !expected.includes(actual);
    case '<':
      return isFiniteNumber(actual) && isFiniteNumber(expected) && actual < expected;
    case '>':
      return isFiniteNumber(actual) && isFiniteNumber(expected) && actual > expected;
    default:
      return false;
  }
}

/** An own property only (never the prototype chain); null counts as absent. */
function readAttribute(attributes: Attributes, name: string): unknown {
  if (!isRecord(attributes) || !Object.prototype.hasOwnProperty.call(attributes, name)) return undefined;
  return attributes[name] ?? undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'boolean' || isFiniteNumber(value);

/** What an 'in' list may hold: strings and finite numbers, never booleans. */
const isListable = (value: unknown): value is string | number => typeof value === 'string' || isFiniteNumber(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
