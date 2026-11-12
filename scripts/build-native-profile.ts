import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { programProfile, sharedGroupPair, tagProgramCore, verifyProgramSide } from '../src/engine-kind.ts';
import { captureProgramInputs, parseProgramReceipt, prepareProgramOutputs, record, verifyProgramReceipt } from './guest-core-receipt.ts';
import { hash, sourceOptions } from './guest-source-manifest.ts';
import { sharedGroupEnvironment, verifySharedSysroot } from './src/program-profile.ts';
import { nativeProfile } from './test-checks.ts';
import { checkGroupFeatures, groupFlags } from '../spidermonkey/shared-group.ts';
import { archiveMembers } from '../spidermonkey/check-build.ts';
import { pin } from '../spidermonkey/native-profile.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
function run(command: string[]) {
  const result = spawnSync(command[0]!, command.slice(1), { cwd: repository, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} failed with ${result.signal ?? result.status}`);
}

export function nativeProfileEngine(value: unknown = 'quickjs') {
  if (value === 'quickjs' || value === 'jsc' || value === 'spidermonkey') return value;
  throw new Error('Unsupported native shared-group engine');
}

function fileIdentity(path: string) {
  const bytes = readFileSync(path);
  return { sha256: hash(bytes), bytes: bytes.byteLength };
}

/** Check the staged group generation, not the old split archive or a receipt alone. */
export function spiderMonkeyNativeInputs(native: string, libcxx: string, sysroot: string) {
  const receiptPath = join(native, 'shared-group-library.json');
  const receipt: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert(record(receipt) && receipt.profile === 'shared-group' && receipt.revision === pin, 'Expected pinned shared-group SpiderMonkey library');
  assert.deepEqual(receipt.sharedSysroot, verifySharedSysroot(sysroot), 'SpiderMonkey library uses a different sysroot');
  assert.deepEqual(receipt.flags, groupFlags, 'SpiderMonkey library flags differ');
  assert(record(receipt.library));
  const library = fileIdentity(join(native, 'libspidermonkey_bunwasm.a'));
  assert.equal(library.sha256, receipt.library.sha256, 'SpiderMonkey library bytes changed');
  assert.equal(library.bytes, receipt.library.bytes, 'SpiderMonkey library size changed');
  assert.equal(fileIdentity(join(native, 'js-confdefs.h')).sha256, receipt.confdefsSha256, 'SpiderMonkey configuration changed');
  const include = join(native, 'include');
  const headers = readdirSync(include, { recursive: true, encoding: 'utf8' })
    .filter(path => /\.(?:h|hpp|inc)$/.test(path) && statSync(join(include, path)).isFile()).sort()
    .map(path => ({ path, sha256: fileIdentity(join(include, path)).sha256 }));
  assert.deepEqual(receipt.headers, { count: headers.length, sha256: hash(JSON.stringify(headers, null, 2) + '\n') }, 'SpiderMonkey headers changed');
  const patches = ['spidermonkey-wasi.patch', 'spidermonkey-shared-group.patch'];
  assert.deepEqual(receipt.patches, patches.map(path => ({ path, sha256: fileIdentity(join(repository, 'spidermonkey', path)).sha256 })), 'SpiderMonkey patches changed');
  const archives = ['libc++.a', 'libc++abi.a'].map(path => ({ path, ...fileIdentity(join(libcxx, path)) }));
  for (const archive of archives) {
    const members = archiveMembers(readFileSync(join(libcxx, archive.path)));
    assert(members.length > 0, 'Empty atomics C++ runtime archive');
    checkGroupFeatures(members);
  }
  return { library, receipt: fileIdentity(receiptPath), headers: receipt.headers, confdefsSha256: receipt.confdefsSha256, archives };
}

function spiderMonkeySources() {
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'spidermonkey', 'scripts/build-native-profile.ts',
    'scripts/build-engine-spidermonkey-shared.sh', 'scripts/spidermonkey-side-core-receipt.ts'], { cwd: repository, encoding: 'utf8' });
  return paths.split('\0').filter(Boolean).map(path => ({ path, ...fileIdentity(join(repository, path)) }));
}

/** This experiment consumes the existing common core; it never becomes a publication profile. */
async function buildSpiderMonkeyProfile(root: string, sysroot: string): Promise<string> {
  const native = process.env.SPIDERMONKEY_NATIVE_DIR;
  const libcxx = process.env.SPIDERMONKEY_LIBCXX_DIR;
  if (!native || !libcxx) throw new Error('SpiderMonkey needs explicit shared native and atomics libc++ directories');
  Object.assign(process.env, sharedGroupEnvironment(sysroot, 'core'));
  const core = join(root, 'core/bun-core.wasm');
  const coreReceipt = parseProgramReceipt(JSON.parse(readFileSync(`${core}.core.json`, 'utf8')));
  const capture = async () => {
    const expected = await captureProgramInputs(sourceOptions(repository, sysroot, 'browser'), 'core',
      { features: ['engine-split', 'bun-transpiler', 'bun-build'], profile: 'shared-group' });
    verifyProgramReceipt(readFileSync(core), coreReceipt, expected);
    return { source: expected.source, core: fileIdentity(core), coreReceipt,
      native: spiderMonkeyNativeInputs(native, libcxx, sysroot), recipes: spiderMonkeySources(),
      environment: sharedGroupEnvironment(sysroot, 'core') };
  };
  const inputs = await capture();
  const side = join(root, 'spidermonkey');
  const program = join(root, 'program-spidermonkey');
  mkdirSync(side, { recursive: true });
  mkdirSync(program, { recursive: true });
  // The producer refuses linked output replacement. Retain its Cargo target but relink once.
  rmSync(join(side, 'engine.wasm'), { force: true });
  writeFileSync(join(side, 'inputs.json'), JSON.stringify(inputs, null, 2) + '\n');
  process.env.SPIDERMONKEY_ENGINE_BUILD_DIR = side;
  run(['bash', 'scripts/build-engine-spidermonkey-shared.sh']);
  assert.deepEqual(await capture(), inputs, 'SpiderMonkey source or native inputs changed during build');
  const bytes = readFileSync(join(side, 'engine.wasm'));
  verifyProgramSide('spidermonkey', new WebAssembly.Module(bytes));
  assert(sharedGroupPair(new WebAssembly.Module(readFileSync(core)), bytes), 'Expected a shared-group SpiderMonkey pair');
  writeFileSync(join(program, 'bun.wasm'), tagProgramCore(readFileSync(core), 'spidermonkey'));
  copyFileSync(join(side, 'engine.wasm'), join(program, programProfile('spidermonkey').side));
  copyFileSync(`${core}.core.json`, join(program, 'bun-core.wasm.core.json'));
  copyFileSync(join(side, 'shared-group-library.json'), join(program, 'shared-group-library.json'));
  writeFileSync(join(program, 'spidermonkey-shared.json'), JSON.stringify({ schema: 1, experimental: true, profile: 'shared-group',
    inputs, program: fileIdentity(join(program, 'bun.wasm')), side: fileIdentity(join(side, 'engine.wasm')) }, null, 2) + '\n');
  writeFileSync(join(program, 'source.txt'), inputs.source.head + '\n');
  return program;
}

export async function buildNativeProfile(profile: unknown, directory: string, selectedEngine: unknown = 'quickjs') {
  const engine = nativeProfileEngine(selectedEngine);
  if (nativeProfile(profile) !== 'shared-group') throw new Error('Split production remains owned by scripts/build.sh');
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (!sysroot || sysroot !== process.env.BUN_WASM_SHARED_SYSROOT) throw new Error('Explicit matching shared-pic sysroot paths are required');
  verifySharedSysroot(sysroot);
  const root = resolve(directory);
  if (engine === 'spidermonkey') return buildSpiderMonkeyProfile(root, sysroot);
  const core = join(root, 'core');
  const side = join(root, engine);
  const program = join(root, engine === 'quickjs' ? 'program' : `program-${engine}`);
  mkdirSync(program, { recursive: true });
  const engineEnvironment = engine === 'quickjs'
    ? { QUICKJS_BUILD_DIR: side, QUICKJS_PROFILE: 'shared-group' }
    : { JSC_ENGINE_BUILD_DIR: side, JSC_PROFILE: 'shared-group' };
  Object.assign(process.env, sharedGroupEnvironment(sysroot, engine), { BUN_CORE_BUILD_DIR: core }, engineEnvironment);
  // The existing retirement helper validates each cached profile before replacing stale outputs.
  await prepareProgramOutputs([
    { artifact: join(core, 'bun-core.wasm'), scope: 'core', selection: { features: ['engine-split', 'bun-transpiler', 'bun-build'], profile: 'shared-group' }, options: sourceOptions(repository, sysroot, 'browser') },
    { artifact: join(side, 'engine.wasm'), scope: engine, profile: 'shared-group', options: sourceOptions(repository, sysroot, engine) },
  ]);
  run(['bash', 'scripts/build-bun-core.sh', '--shared-group']);
  run(['bash', `scripts/build-engine-${engine}.sh`]);
  run(['bun', 'scripts/guest-core-receipt.ts', 'tag', join(core, 'bun-core.wasm'), engine, join(program, 'bun.wasm')]);
  const companion = programProfile(engine).side;
  copyFileSync(join(side, 'engine.wasm'), join(program, companion));
  copyFileSync(join(side, 'engine.wasm.engine.json'), join(program, `${companion}.engine.json`));
  copyFileSync(join(core, 'bun-core.wasm.core.json'), join(program, 'bun-core.wasm.core.json'));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' });
  if (head.status !== 0) throw new Error('Cannot identify native profile source');
  writeFileSync(join(program, 'source.txt'), head.stdout);
  return program;
}

if (import.meta.main) {
  const [profile, directory, engine] = process.argv.slice(2);
  if (!directory) throw new Error('Usage: source env.sh; bun scripts/build-native-profile.ts shared-group OUTPUT [quickjs|jsc|spidermonkey]');
  console.log(await buildNativeProfile(profile, directory, engine));
}
