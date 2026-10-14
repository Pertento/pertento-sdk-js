# Contributing

Thanks for helping improve `@pertentoai/sdk`. This file lists the rules that keep the SDK safe
to run inside other people's servers.

## The evaluator and its spec

`src/evaluator/`, `spec/SPEC.md` and `spec/vectors.json` define how a variant is chosen. The
Pertento tracking server has its own implementation of the same spec (it answers `/sdk/decide`
and `/sdk/events`), and both MUST pass the same `vectors.json`. If they ever disagreed, the
server and the SDK would put one person in two different variants.

- A change to hashing, the decision rules or the config shape is a new spec version: bump
  `SDK_CONFIG_VERSION` and the version in the spec's title, and regenerate the vectors with
  `bun scripts/generate-vectors.ts --force`. Adding an optional config field needs no bump.
- Never regenerate `vectors.json` to make a failing test pass. A failing vector means the code
  is wrong.

## Runtime constraints

- **Zero runtime dependencies.** Only `fetch` and Web Crypto. The bundle must run unchanged on
  Node 20+, Bun, Deno and edge workers. `scripts/build.ts` fails on any `Bun.`, `bun:`, `node:` or
  `require(` in `dist/index.js`, and `node scripts/node-smoke.mjs` checks the build in plain Node.
- Nothing after `createPertento` throws into the caller's request. Failures resolve to control
  (or `{ ok: false }`) and are reported through `lastError`, logged once per kind.
- `track()` sends at most once: one attempt, never a retry, so a conversion is never counted twice.
- No em dashes or en dashes in anything users read (README, error messages, TSDoc).

## Dependencies

- Check every package for security advisories before adding or upgrading it, and pin an exact
  version. Prefer adding nothing.
- Install with `bun install --frozen-lockfile` and commit `bun.lock`. No install or postinstall
  scripts.
- GitHub Actions are pinned to full commit SHAs, with the version in a comment.

## Commands

```sh
bun test                    # evaluator and SDK tests
bun run typecheck           # src, strictest options, no Bun or DOM types
bun run build               # dist/index.js (Bun.build) + declarations (tsc)
bun run typecheck:consumer  # dist/ as a nodenext project sees it
node scripts/node-smoke.mjs # every decision vector through dist/ in plain Node
```

## Pull requests

`main` is protected, so every change goes through a pull request. Commit messages are a plain
lowercase sentence with no prefix, and the body explains why.

## Releases

Only the Release workflow publishes (a `v*` tag, npm trusted publishing with provenance). See
[RELEASING.md](./RELEASING.md).
