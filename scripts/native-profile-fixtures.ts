import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { programKind, programProfile, sharedGroupPair } from '../src/engine-kind.ts';
import { parseCheckId, requireEntryFiles, selectChecks } from './test-checks.ts';
import { spiderMonkeyTiers, spiderMonkeyTierOptions, verifySpiderMonkeyQualification, type SpiderMonkeyTier } from './spidermonkey-native-qualification.ts';

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

/** `ids` are check ids (`test-checks.ts`): a fixture path, or `path#entry` for one of its named commands. */
export function runProfileFixtures(ids: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const artifacts = profileArtifacts(env);
  return runDeclaredFixtures(ids, selectChecks('native', undefined, 'shared-group'), root, artifacts, env);
}

type Artifacts = ReturnType<typeof profileArtifacts>;

/** Every selected id runs once, or once per SpiderMonkey tier, and only if a manifest declares it. */
export function runDeclaredFixtures(ids: readonly string[], declared: readonly string[], directory: string, artifacts: Artifacts, env: NodeJS.ProcessEnv) {
  if (ids.length === 0 || new Set(ids).size !== ids.length || ids.some(id => !declared.includes(id))) throw new Error('Shared fixture selection is empty, repeated or undeclared');
  const results = ids.flatMap(id => artifacts.engine === 'spidermonkey'
    ? spiderMonkeyTiers.map(tier => runFixture(id, directory, artifacts, env, tier))
    : [runFixture(id, directory, artifacts, env)]);
  const late = results.find(result => result.wallMs > COMMAND_TIMEOUT_MS);
  if (late) throw new Error(`${late.id}: ${late.tier ?? artifacts.engine} exceeded ${COMMAND_TIMEOUT_MS} ms, completed in ${late.wallMs} ms`);
  return results;
}

/** Each command has the same bound, whichever entry of a fixture it is. */
const COMMAND_TIMEOUT_MS = 120_000;

function runFixture(id: string, directory: string, artifacts: Artifacts, env: NodeJS.ProcessEnv, tier?: SpiderMonkeyTier) {
  const { path, entry } = parseCheckId(id);
  const source = join(directory, path);
  // Checked in the repository before anything is copied or launched: regular files of this fixture.
  const files = requireEntryFiles(source, entry, id);
  const scratch = mkdtempSync(join(tmpdir(), 'bun-wasm-native-profile-'));
  try {
    cpSync(source, scratch, { recursive: true });
    const command = readFileSync(join(scratch, files.command), 'utf8').trim().split('\n');
    if (command.length === 0 || command.some(argument => !argument || argument.includes('\0'))) throw new Error('Invalid profile fixture command');
    const options = tier ? spiderMonkeyTierOptions(tier, env) : { args: [], env };
    const args = ['--wasm', artifacts.program, '--dir', `${scratch}::/`, '--env', 'PWD=/', '--env', 'HOME=/'].concat(options.args, ['--'], command);
    // Temporary hosted observation: retain the pass deadline while allowing completion evidence.
    const observe = env.CI === 'true' && id === 'tests/fixtures/shared-wasm-memory#lifetime';
    const started = performance.now();
    // An argument vector, never a shell.
    const result = spawnSync(artifacts.launcher, args, { env: options.env, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS * (observe ? 2 : 1), maxBuffer: 8 << 20 });
    const wallMs = performance.now() - started;
    writeSync(1, result.stdout ?? '');
    writeSync(2, result.stderr ?? '');
    if (observe) writeSync(2, `${JSON.stringify({ lifetimeObservation: 'returned', engine: artifacts.engine, tier, wallMs, status: result.status, signal: result.signal, error: result.error?.message ?? null })}\n`);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${id}: guest failed with ${result.signal ?? result.status}`);
    const expected = readFileSync(join(scratch, files.expected), 'utf8');
    if (result.stdout !== expected) throw new Error(`${id}: shared native output differs from ${files.expected}`);
    const qualification = tier ? verifySpiderMonkeyQualification(result.stderr, tier) : undefined;
    if (observe) writeSync(2, `${JSON.stringify({ lifetimeObservation: 'qualified', engine: artifacts.engine, tier, wallMs, passDeadlineMs: COMMAND_TIMEOUT_MS, qualification })}\n`);
    return { id, path, entry: entry ?? null, tier: tier ?? null, wallMs, kind: `real-${artifacts.engine}-shared-group-native`, qualification };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) console.log(JSON.stringify(runProfileFixtures(process.argv.slice(2)), null, 2));
