# Releasing @pertentoai/sdk

Releases are published by [`.github/workflows/release.yml`](./.github/workflows/release.yml)
when a `v*` tag is pushed, using npm **trusted publishing**: the workflow proves who it is with
a short-lived GitHub OIDC token, so no npm token is stored anywhere, and every release carries
a **provenance** attestation that links the tarball to the commit and workflow run that built it.

npm can only attach a trusted publisher to a package that already exists, so the very first
version is published by hand, once. Everything after that goes through the workflow.

## One time: the first publish (0.1.0), by a maintainer

Run from a fresh clone of `main` at the merged commit, never from a working copy with local
changes:

```sh
git clone git@github.com:Pertento/pertento-sdk-js.git && cd pertento-sdk-js
bun install --frozen-lockfile
bun test && bun run typecheck && bun run build && bun run typecheck:consumer && node scripts/node-smoke.mjs
npm pack --dry-run          # check the file list: dist/, README.md, LICENSE, package.json only
npm login                   # an account in the pertentoai npm org, with 2FA
npm publish --access public --provenance=false
npm view @pertentoai/sdk    # 0.1.0 is there
```

`--provenance=false` is required here: `package.json` asks for provenance on every publish,
and npm can only generate it inside a supported CI. **So 0.1.0 carries no provenance; every
later version does.**

## One time: configure the trusted publisher

On npmjs.com, open `@pertentoai/sdk`, Settings, **Trusted Publisher**, and add a GitHub Actions
publisher:

| Field | Value |
| --- | --- |
| Organization or user | `Pertento` |
| Repository | `pertento-sdk-js` |
| Workflow filename | `release.yml` |
| Environment | leave empty |

npm deletes a trusted publisher configuration that has not published within **2 days** of being
created, so add it when the next version is ready to tag, not before.

After the first release through the workflow succeeds, tighten the package: Settings,
Publishing access, **Require two-factor authentication and disallow tokens**. From then on the
workflow is the only way to publish. **Never publish from a laptop again.**

Also worth doing once in the GitHub repository settings: a tag ruleset that lets only
maintainers create `v*` tags, since pushing such a tag publishes.

## Every release after that

1. Open a PR that bumps `version` in `package.json` (semver; while on 0.x, a breaking change
   bumps the minor). Merge it once CI is green.
2. Tag the merge commit on `main` and push the tag:

   ```sh
   git checkout main && git pull
   git tag v0.1.1
   git push origin v0.1.1
   ```

3. The Release workflow checks that the tag equals the `package.json` version, runs the tests,
   the typechecks, the build and the Node smoke test, and publishes with
   `npm publish --provenance --access public`. If any step fails nothing is published; fix it,
   delete the tag (`git push origin :refs/tags/v0.1.1`), and tag again.
4. Check the release on npmjs.com: the version page shows a provenance badge linking to the
   workflow run.

The workflow runs on Node 24, whose bundled npm (11.x) supports trusted publishing (npm 11.5.1
or later and Node 22.14.0 or later are required); a step fails the release early if that ever
stops being true.
