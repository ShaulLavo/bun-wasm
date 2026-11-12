import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifySharedSysroot } from './src/program-profile.ts';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path: string) => hash(readFileSync(path));
const repository = resolve(import.meta.dir, '..');
const recipePaths = ['spidermonkey', 'crates/bunwasm-spidermonkey', 'Cargo.lock', 'rust-toolchain.toml', 'env.sh',
  'scripts/src/program-profile.ts', 'src/engine-kind.ts', 'scripts/ci-spidermonkey-prebuild.ts', '.github/workflows/ci.yml'];

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

export function sharedSpiderMonkeyRecipes(): string {
  const paths = git(['ls-files', '-z', '--'].concat(recipePaths)).split('\0').filter(Boolean).sort();
  return hash(JSON.stringify(paths.map(path => ({ path, sha256: fileHash(join(repository, path)) }))));
}

/** Only the staged archive, dereferenced headers and verification receipts cross jobs. */
function files(root: string, path: string): { path: string; sha256: string }[] {
  const absolute = join(root, path);
  const stat = lstatSync(absolute);
  if (stat.isDirectory()) return readdirSync(absolute).sort().flatMap(name => files(root, `${path}/${name}`));
  assert(stat.isFile(), `SpiderMonkey prebuild cannot transfer a link or special file: ${path}`);
  return [{ path, sha256: fileHash(absolute) }];
}

function context(sysroot: string) {
  assert(process.env.GITHUB_RUN_ID && process.env.GITHUB_SHA, 'Missing CI run/source identity');
  assert.equal(git(['rev-parse', 'HEAD']), process.env.GITHUB_SHA, 'Checkout differs from CI source');
  return { run: process.env.GITHUB_RUN_ID, source: process.env.GITHUB_SHA, tree: git(['rev-parse', 'HEAD^{tree}']),
    recipes: sharedSpiderMonkeyRecipes(), sharedSysroot: verifySharedSysroot(sysroot) };
}

function closure(root: string) {
  return files(root, 'native').concat(files(root, 'receipt'));
}

export function writePrebuild(root: string, sysroot: string, nativeInputs: string): string {
  assert(/^[0-9a-f]{64}$/.test(nativeInputs), 'Missing native tool/sysroot input hash');
  assert.equal(fileHash(join(root, 'native/shared-group-library.json')), fileHash(join(root, 'receipt/shared-group-library.json')),
    'Staged library receipt differs');
  const manifest = JSON.stringify({ schema: 1, ...context(sysroot), nativeInputs, files: closure(root) }, null, 2) + '\n';
  writeFileSync(join(root, 'prebuild.json'), manifest);
  return hash(manifest);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function verifyPrebuild(root: string, sysroot: string, expectedHash: string): void {
  assert(/^[0-9a-f]{64}$/.test(expectedHash), 'Missing producer manifest hash');
  const raw = readFileSync(join(root, 'prebuild.json'));
  assert.equal(hash(raw), expectedHash, 'SpiderMonkey producer manifest changed');
  const manifest: unknown = JSON.parse(raw.toString());
  assert(record(manifest) && manifest.schema === 1, 'Invalid SpiderMonkey prebuild');
  const expected = context(sysroot);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(manifest[key], value, `SpiderMonkey prebuild ${key} changed`);
  assert(typeof manifest.nativeInputs === 'string' && /^[0-9a-f]{64}$/.test(manifest.nativeInputs), 'Invalid native tool/sysroot identity');
  assert.deepEqual(manifest.files, closure(root), 'SpiderMonkey prebuild bytes or file closure changed');
  assert.equal(fileHash(join(root, 'native/shared-group-library.json')), fileHash(join(root, 'receipt/shared-group-library.json')),
    'Staged library receipt differs');
}

if (import.meta.main) {
  const [mode, root, identity] = process.argv.slice(2);
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (mode === 'recipes') {
    process.stdout.write(sharedSpiderMonkeyRecipes() + '\n');
    process.exit(0);
  }
  assert(root && identity && sysroot, 'Usage: ci-spidermonkey-prebuild.ts write|verify BUILD_DIR INPUT_HASH|MANIFEST_HASH');
  if (mode === 'write') process.stdout.write(writePrebuild(root, sysroot, identity) + '\n');
  else {
    assert.equal(mode, 'verify');
    verifyPrebuild(root, sysroot, identity);
  }
}
