/**
 * Builds dist/: one readable ESM file (the evaluator inlined, nothing minified, so a customer
 * can read exactly what runs in their process) and the .d.ts files from TypeScript.
 *
 *   bun run build
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const outdir = resolve(root, 'dist');

rmSync(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/index.ts')],
  outdir,
  format: 'esm',
  target: 'node',
  minify: false,
  sourcemap: 'none',
  packages: 'bundle',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const tsc = Bun.spawnSync(['bunx', 'tsc', '-p', resolve(root, 'tsconfig.build.json')], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
});
if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);

/**
 * tsc keeps the sources' extensionless specifiers (`from './types'`), which a consumer on
 * `moduleResolution: node16 | nodenext` cannot resolve. Rewrite every relative specifier in the
 * declarations to the file it means (`./types.js`, `./evaluator/index.js`). The sources keep
 * their extensionless specifiers, which Bun and bundlers resolve.
 */
function fixDeclarationSpecifiers(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      fixDeclarationSpecifiers(path);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;
    const source = readFileSync(path, 'utf8');
    const fixed = source.replace(
      /((?:from\s+|import\()['"])(\.{1,2}\/[^'"]*?)(['"])/g,
      (match, before: string, specifier: string, after: string) => {
        if (specifier.endsWith('.js')) return match;
        const target = resolve(dirname(path), specifier);
        if (existsSync(`${target}.d.ts`)) return `${before}${specifier}.js${after}`;
        if (existsSync(join(target, 'index.d.ts'))) return `${before}${specifier}/index.js${after}`;
        throw new Error(`${path}: cannot resolve ${specifier}`);
      },
    );
    if (fixed !== source) writeFileSync(path, fixed);
  }
}
fixDeclarationSpecifiers(outdir);

// The bundle runs in Node, Deno and edge workers: nothing Bun-specific may survive into it.
const bundle = await Bun.file(resolve(outdir, 'index.js')).text();
const leaks = ['Bun.', 'bun:', 'node:', 'require('].filter((needle) => bundle.includes(needle));
if (leaks.length > 0) {
  console.error(`dist/index.js references ${leaks.join(', ')}; the SDK must use only fetch and Web Crypto`);
  process.exit(1);
}

if (!bundle.includes('function createPertento(')) {
  console.error('dist/index.js does not define createPertento; the bundler dropped the entry\'s exports');
  process.exit(1);
}

console.log(`Built dist/index.js (${bundle.length} bytes) and declarations`);
