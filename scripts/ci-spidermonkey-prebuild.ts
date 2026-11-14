import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { verifySharedSysroot } from './src/program-profile.ts';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fileHash = (path: string) => hash(readFileSync(path));
const repository = resolve(import.meta.dir, '..');
const recipePaths = ['spidermonkey', 'crates/bunwasm-spidermonkey', 'Cargo.lock', 'rust-toolchain.toml', 'env.sh',
  'scripts/src/program-profile.ts', 'src/engine-kind.ts', 'scripts/ci-spidermonkey-prebuild.ts',
  'package.json', 'bun.lock', 'scripts/ci-bootstrap-tools.ts', 'scripts/ci-install.ts',
  'scripts/ci-stage-release-packages.ts', 'scripts/ci-release-download.ts', 'scripts/ci-build-tools.ts'];

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  const result = JSON.stringify(value);
  assert(result !== undefined, 'Invalid producer recipe value');
  return result;
}

/** Setup and compilation can change native work. Transfer/reporting and other jobs cannot. */
function producerRecipe(root: string) {
  const workflow: unknown = Bun.YAML.parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
  assert(record(workflow) && record(workflow.jobs));
  const producer = workflow.jobs['shared-spidermonkey-prebuild'];
  assert(record(producer) && Array.isArray(producer.steps), 'Missing shared SpiderMonkey producer');
  const steps: unknown[] = producer.steps;
  const boundary = steps.findIndex(step => record(step) && step.id === 'shared-sm-artifact');
  assert(boundary > 0, 'Missing SpiderMonkey transfer boundary');
  const build = steps.slice(0, boundary);
  assert(build.some(step => record(step) && typeof step.run === 'string' && step.run.includes('bash spidermonkey/build-shared-group.sh')),
    'Missing shared SpiderMonkey build command');
  const metadata = new Set(['name', 'needs', 'if', 'outputs', 'timeout-minutes', 'steps']);
  const configuration = Object.fromEntries(Object.entries(producer).filter(([key]) => !metadata.has(key)));
  return { workflow: { env: workflow.env ?? {}, defaults: workflow.defaults ?? {}, permissions: workflow.permissions ?? {} },
    configuration, steps: build };
}

function localActions(root: string, value: unknown, paths = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) localActions(root, entry, paths);
    return paths;
  }
  if (!record(value)) return paths;
  if (typeof value.uses === 'string' && value.uses.startsWith('./') && !paths.has(value.uses)) {
    const path = value.uses;
    assert(/^\.\/\.github\/actions\/[\w/-]+$/.test(path), 'Unexpected local producer action path');
    paths.add(path);
    const action: unknown = Bun.YAML.parse(readFileSync(join(root, path, 'action.yml'), 'utf8'));
    localActions(root, action, paths);
  }
  for (const entry of Object.values(value)) localActions(root, entry, paths);
  return paths;
}

function commandRecipes(root: string, producer: unknown, actions: Set<string>): string[] {
  const commands = canonical(producer) + Array.from(actions, path => readFileSync(join(root, path, 'action.yml'), 'utf8')).join('\n');
  return Array.from(commands.matchAll(/(?:scripts|spidermonkey)\/[\w/.-]+\.(?:ts|mts|sh|json)\b/g), match => match[0]);
}

/** Follow local tool/verification imports too, so extracting a helper cannot hide later edits. */
function importedRecipes(root: string, paths: string[]): string[] {
  const inputs = new Set(paths);
  const scanner = new Bun.Transpiler({ loader: 'ts' });
  for (const path of inputs) {
    if (!/\.(?:ts|mts)$/.test(path)) continue;
    const imports = scanner.scanImports(readFileSync(join(root, path), 'utf8'));
    for (const entry of imports) {
      if (!entry.path.startsWith('.')) continue;
      const base = join(dirname(path), entry.path);
      const dependency = [base, base + '.ts', join(base, 'index.ts')].find(candidate => existsSync(join(root, candidate)) && lstatSync(join(root, candidate)).isFile());
      assert(dependency, `Missing producer import: ${path}: ${entry.path}`);
      assert(!relative(root, resolve(root, dependency)).startsWith('..'), 'Producer import escapes repository');
      inputs.add(dependency);
    }
  }
  return Array.from(inputs).sort();
}

export function sharedSpiderMonkeyRecipes(root = repository): string {
  const producer = producerRecipe(root);
  const actions = localActions(root, producer);
  const commands = commandRecipes(root, producer, actions);
  for (const path of commands) assert(existsSync(join(root, path)), `Missing producer command input: ${path}`);
  const inputs = recipePaths.concat(Array.from(actions, path => path.slice(2)), commands);
  const tracked = execFileSync('git', ['ls-files', '-z', '--'].concat(inputs), { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const imports = importedRecipes(root, recipePaths.filter(path => path.endsWith('.ts')).concat(commands, ['spidermonkey/shared-group.ts']));
  const paths = Array.from(new Set(tracked.concat(imports))).sort();
  return hash(canonical({ producer, files: paths.map(path => ({ path, sha256: fileHash(join(root, path)) })) }));
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
