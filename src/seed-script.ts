import type { Decision } from './evaluator';
import { buildSeed, isUuid, serializeSeed } from './evaluator';

export type SeedScriptOptions = {
  /** Your Content-Security-Policy nonce, written as the script's `nonce` attribute. */
  nonce?: string;
};

const escapeAttribute = (value: string): string =>
  value.replace(/[&"<>]/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The `<script>` that hands your server's decisions to the Pertento snippet. Print it in
 * `<head>`, before the snippet. Only enrolled decisions go in. The JSON is escaped so no value
 * can close the element (spec/SPEC.md, section 9).
 */
export function seedScript(
  decisions: readonly Decision[] | Readonly<Record<string, Decision>>,
  visitorId?: string,
  options: SeedScriptOptions = {},
): string {
  const list = Array.isArray(decisions) ? decisions : Object.values(decisions as Record<string, Decision>);
  // Lowercased as the server stores it, so the browser keeps the same ID the server enrols.
  const seededId = visitorId !== undefined && isUuid(visitorId) ? visitorId.toLowerCase() : visitorId;
  const json = serializeSeed(buildSeed(list, seededId));
  const nonce = options.nonce === undefined ? '' : ` nonce="${escapeAttribute(options.nonce)}"`;
  return `<script${nonce}>window.PertentoSeed=${json};</script>`;
}
