/**
 * `@pertentoai/sdk`: decide Pertento experiments on your server, seed the page with the
 * decisions, and report conversions from your backend. Runs on Node 20+, Bun, Deno and edge
 * workers; it uses only `fetch` and Web Crypto and has no dependencies.
 *
 * @packageDocumentation
 */
export type { PertentoError, PertentoErrorKind, PertentoErrorSource } from './errors';
export type {
  Attributes,
  Decision,
  DecisionReason,
  EnrolledDecision,
  NotEnrolledDecision,
  SdkConfig,
  Seed,
  VariantMap,
} from './evaluator';
export type { FetchInit, FetchLike, FetchResponse } from './http';
export type { SeedScriptOptions } from './seed-script';
export type { TrackOptions, TrackResult } from './track';
// `export *`, not `export { createPertento }`: Bun 1.3's bundler drops a named re-export from
// the entry of a `sideEffects: false` package and emits an empty module. client.ts exports
// only createPertento and its types, so `*` is exactly that. scripts/build.ts checks it.
export * from './client';
