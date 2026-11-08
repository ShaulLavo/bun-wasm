import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { programProfile, type SupportedPairedEngine } from '../src/engine-kind.ts';
import { prepareProgramOutputs } from './guest-core-receipt.ts';
import { sourceOptions } from './guest-source-manifest.ts';
import { sharedGroupEnvironment, verifySharedSysroot } from './src/program-profile.ts';
import { nativeProfile } from './test-checks.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
function run(command: string[]) {
  const result = spawnSync(command[0]!, command.slice(1), { cwd: repository, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command[0]} failed with ${result.signal ?? result.status}`);
}

export async function buildNativeProfile(profile: unknown, directory: string, engine: SupportedPairedEngine = 'quickjs') {
  if (nativeProfile(profile) !== 'shared-group') throw new Error('Split production remains owned by scripts/build.sh');
  const sysroot = process.env.BUN_WASM_SYSROOT;
  if (!sysroot || sysroot !== process.env.BUN_WASM_SHARED_SYSROOT) throw new Error('Explicit matching shared-pic sysroot paths are required');
  verifySharedSysroot(sysroot);
  const root = resolve(directory);
  const core = join(root, 'core');
  const side = join(root, engine);
  const program = join(root, 'program');
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
  if (!directory || (engine !== undefined && engine !== 'quickjs' && engine !== 'jsc')) throw new Error('Usage: source env.sh; bun scripts/build-native-profile.ts shared-group OUTPUT [quickjs|jsc]');
  console.log(await buildNativeProfile(profile, directory, engine));
}
