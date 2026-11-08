import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { programKind, programProfile, sharedGroupPair } from '../src/engine-kind.ts';
import { selectChecks } from './test-checks.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

export function profileArtifacts(env: NodeJS.ProcessEnv) {
  const program = env.BUN_WASM_PROFILE_PROGRAM;
  const launcher = env.BUN_WASM_LAUNCHER;
  if (!program || !launcher) throw new Error('Shared native checks require BUN_WASM_PROFILE_PROGRAM and BUN_WASM_LAUNCHER');
  if (!statSync(program).isFile() || !statSync(launcher).isFile()) throw new Error('Shared native artifact is not a file');
  const module = new WebAssembly.Module(readFileSync(program));
  const engine = programKind(module);
  if (engine === 'single') throw new Error('Shared native checks require a paired core');
  const side = readFileSync(join(resolve(program, '..'), programProfile(engine).side));
  if (!sharedGroupPair(module, side)) throw new Error('Shared native checks require a matching shared-group core and engine side');
  return { program: resolve(program), launcher: resolve(launcher), engine };
}

export function runProfileFixtures(paths: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const artifacts = profileArtifacts(env);
  const declared = new Set(selectChecks('native', undefined, 'shared-group'));
  if (paths.length === 0 || paths.some(path => !declared.has(path))) throw new Error('Shared fixture selection is empty or undeclared');
  return paths.map(path => runFixture(path, artifacts, env));
}

function runFixture(path: string, artifacts: ReturnType<typeof profileArtifacts>, env: NodeJS.ProcessEnv) {
  const source = join(root, path);
  const scratch = mkdtempSync(join(tmpdir(), 'bun-wasm-native-profile-'));
  try {
    cpSync(source, scratch, { recursive: true });
    const command = readFileSync(join(scratch, 'cmd'), 'utf8').trim().split('\n');
    if (command.length === 0 || command.some(argument => !argument || argument.includes('\0'))) throw new Error('Invalid profile fixture command');
    const args = ['--wasm', artifacts.program, '--dir', `${scratch}::/`, '--env', 'PWD=/', '--env', 'HOME=/', '--'].concat(command);
    const started = performance.now();
    const result = spawnSync(artifacts.launcher, args, { env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 << 20 });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path}: guest failed with ${result.signal ?? result.status}`);
    const expected = readFileSync(join(scratch, 'expected.txt'), 'utf8');
    if (result.stdout !== expected) throw new Error(`${path}: shared native output differs from expected.txt`);
    return { path, wallMs: performance.now() - started, kind: `real-${artifacts.engine}-shared-group-native` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) console.log(JSON.stringify(runProfileFixtures(process.argv.slice(2)), null, 2));
