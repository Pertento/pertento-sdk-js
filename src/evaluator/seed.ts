import type { Decision, Seed, SeedAssignment } from './types';

/**
 * The seed a page carries as `window.PertentoSeed`. Only enrolled decisions go in: the
 * browser runtime enrols exactly what the seed names, and a server-decided experiment
 * the seed leaves out is not run in the browser at all.
 */
export function buildSeed(decisions: readonly Decision[], visitorId?: string): Seed {
  const assignments: Record<string, SeedAssignment> = {};
  for (const decision of decisions) {
    if (!decision.enrolled) continue;
    const assignment: SeedAssignment = { variantId: String(decision.variantId) };
    assignments[String(decision.experimentId)] =
      decision.enrolAs === undefined ? assignment : { ...assignment, enrolAs: decision.enrolAs };
  }
  return visitorId === undefined ? { assignments } : { visitorId, assignments };
}

// Built from code points so no editor or tool can turn the escapes into raw separators.
const UNSAFE_IN_SCRIPT = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

/**
 * JSON safe to inline inside a `<script>` element: `<`, `>`, `&`, U+2028 and U+2029 are
 * written as \uXXXX escapes, so a value can never close the script (`</script>`), open
 * a comment (`<!--`) or break a pre-ES2019 parser. Those characters can only occur
 * inside JSON string literals, where the escape means the same thing, so
 * JSON.parse(serializeSeed(seed)) deep-equals the seed.
 */
export const serializeSeed = (seed: Readonly<Seed>): string =>
  JSON.stringify(seed).replace(UNSAFE_IN_SCRIPT, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
