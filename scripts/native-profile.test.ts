import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkArguments, checkBatches, checkCommand, checkId, discoverChecks, entryFiles, parseCheck, parseCheckId, selectChecks } from './test-checks.ts';
import { profileArtifacts } from './native-profile-fixtures.ts';
import { needsRust, needsSharedNative, sharedNativeFiles } from './ci-changes.ts';

const split = parseCheck({ owner: 'native', path: 'tests/fixtures/regular' }, 'native-regular.json');
const shared = parseCheck({ owner: 'native', path: 'tests/fixtures/shared', profile: 'shared-group' }, 'native-shared.json');

test('ordinary native selection and command stay split while shared selection is explicit', () => {
  expect(selectChecks('native', [split, shared])).toEqual(['tests/fixtures/regular']);
  expect(selectChecks('native', [split, shared], 'shared-group')).toEqual(['tests/fixtures/shared']);
  expect(checkCommand('native', ['tests/fixtures/regular']).slice(-1)).toEqual(['regular']);
  expect(checkCommand('native', ['tests/fixtures/shared'], 'shared-group').slice(-2)).toEqual([expect.stringContaining('native-profile-fixtures.ts'), 'tests/fixtures/shared']);
});

const fixture = 'tests/fixtures/shared';
const entry = (name: unknown, more: Record<string, unknown> = {}) => parseCheck({ owner: 'native', path: fixture, profile: 'shared-group', entry: name, ...more }, 'native-shared-entry.json');

test('a native shared-group fixture may name a second command, and nothing else may', () => {
  expect(entry('lifetime')).toEqual({ owner: 'native', path: fixture, profile: 'shared-group', entry: 'lifetime', localRuntime: false, batch: 'default' });
  expect(checkId(entry('lifetime'))).toBe(`${fixture}#lifetime`);
  expect(checkId(shared)).toBe(fixture);
  expect(parseCheckId(`${fixture}#lifetime`)).toEqual({ path: fixture, entry: 'lifetime' });
  expect(parseCheckId(fixture)).toEqual({ path: fixture });
  expect(entryFiles()).toEqual({ command: 'cmd', expected: 'expected.txt' });
  expect(entryFiles('long-run2')).toEqual({ command: 'cmd.long-run2', expected: 'expected.long-run2.txt' });
  // The entry is a closed name: nothing that could leave the fixture or reach a shell.
  const unsafe = ['', 'Lifetime', 'a_b', 'a--b', '-a', 'a-', 'a/b', '../x', '..', 'a.b', 'a b', 'a;b', '$(x)', 'a\nb', 'a#b', 'x'.repeat(33), null, 7, true, ['lifetime']];
  for (const name of unsafe) {
    expect(() => entry(name), String(name)).toThrow('Unsafe check entry');
    if (typeof name === 'string') expect(() => parseCheckId(`${fixture}#${name}`), name).toThrow('Unsafe check entry');
  }
  // Only the native shared-group owner has entries, and unknown fields stay rejected.
  expect(() => parseCheck({ owner: 'native', path: fixture, entry: 'lifetime' }, 'native-shared.json')).toThrow('Only native shared-group checks name an entry');
  expect(() => parseCheck({ owner: 'native', path: fixture, profile: 'split', entry: 'lifetime' }, 'native-shared.json')).toThrow('Only native shared-group');
  expect(() => parseCheck({ owner: 'browser-guest', path: 'scripts/example.test.ts', profile: 'shared-group', entry: 'lifetime' }, 'browser-guest-example.json')).toThrow('Only native shared-group');
  expect(() => parseCheck({ owner: 'quality', path: 'scripts/example.test.ts', entry: 'lifetime' }, 'quality-example.json')).toThrow('Only native shared-group');
  expect(() => entry('lifetime', { command: 'cmd.other' })).toThrow('Unknown check fields');
});

test('selection, batching and the command keep both commands of one fixture apart', () => {
  const lifetime = entry('lifetime');
  const checks = [split, shared, lifetime];
  const ids = selectChecks('native', checks, 'shared-group');
  expect(ids).toEqual([fixture, `${fixture}#lifetime`]);
  // The same path twice: a set of paths would have dropped one.
  expect(new Set(ids.map(id => parseCheckId(id).path)).size).toBe(1);
  expect(checkBatches('native', checks, 'shared-group')).toEqual([ids]);
  expect(checkCommand('native', ids, 'shared-group').slice(-2)).toEqual(ids);
  expect(selectChecks('native', checks)).toEqual(['tests/fixtures/regular']);
});

test('the repository declares the lifetime command beside the default one, each once', () => {
  const path = 'tests/fixtures/shared-wasm-memory';
  const declared = discoverChecks().filter(check => check.path === path);
  expect(declared.map(checkId)).toEqual([path, `${path}#lifetime`]);
  expect(selectChecks('native', undefined, 'shared-group').filter(id => id.startsWith(path))).toEqual([path, `${path}#lifetime`]);
  const read = (name: string) => readFileSync(join(import.meta.dir, '..', path, name), 'utf8');
  const lines = (name: string) => read(name).trimEnd().split('\n');
  // The two commands print the original 28 result lines between them, each once.
  const both = lines('expected.txt').concat(lines('expected.lifetime.txt'));
  expect(both).toHaveLength(28);
  expect(new Set(both).size).toBe(28);
  expect(lines('expected.lifetime.txt')).toEqual(['shared-wasm-memory group lane lifetime: pass', 'plain-sab: pass']);
  // The lifetime run and the control moved with it each start in exactly one place.
  const starts = (file: string, name: string) => read(file).split(`'${name}'`).length - 1;
  expect([starts('group-lane-lifetime-control.ts', 'group-lane-lifetime'), starts('group-lane-control.ts', 'group-lane-lifetime')]).toEqual([1, 0]);
  expect([starts('group-lane-lifetime-control.ts', 'plain-sab'), starts('binding-controls.ts', 'plain-sab')]).toEqual([1, 0]);
  expect(read('cmd.lifetime')).toBe('run\n/group-lane-lifetime-control.ts\n');
  // The run itself is unchanged in size, and the Browser harness still starts it directly.
  expect(read('group-lane-lifetime.ts')).toContain('for (let index = 0; index < 200; index++) {');
  expect(starts('browser-transport-controls.ts', 'group-lane-lifetime')).toBe(1);
  // Each command keeps the one bound.
  const runner = readFileSync(join(import.meta.dir, 'native-profile-fixtures.ts'), 'utf8');
  expect(runner).toContain('const COMMAND_TIMEOUT_MS = 120_000;');
  expect(runner.split('timeout: COMMAND_TIMEOUT_MS').length - 1).toBe(1);
});

test('profile manifests reject unknown values and unrelated owners', () => {
  for (const profile of [null, true, '', 'threaded', 'shared', 'browser']) {
    expect(() => parseCheck({ owner: 'native', path: 'tests/fixtures/shared', profile }, 'native-shared.json')).toThrow();
  }
  expect(() => parseCheck({ owner: 'quality', path: 'scripts/example.test.ts', profile: 'shared-group' }, 'quality-example.json')).toThrow();
  expect(parseCheck({ owner: 'native', path: 'tests/fixtures/regular', profile: 'split' }, 'native-regular.json')).toEqual(split);
});

test('CLI profile selection is closed and missing group artifacts fail', () => {
  expect(checkArguments(['native', '--profile', 'shared-group', '--list'])).toEqual({ owner: 'native', profile: 'shared-group', list: true, batch: undefined, batches: false });
  expect(checkArguments(['native', '--list'])).toEqual({ owner: 'native', profile: 'split', list: true, batch: undefined, batches: false });
  for (const args of [['native', '--profile'], ['native', '--profile', 'browser'], ['native', '--list', '--list'], ['web', '--profile', 'shared-group']]) {
    expect(() => checkArguments(args)).toThrow();
  }
  expect(() => profileArtifacts({})).toThrow('require');
  expect(() => profileArtifacts({ BUN_WASM_PROFILE_PROGRAM: '/absent/group.wasm', BUN_WASM_LAUNCHER: '/absent/launcher' })).toThrow();
});

test('group source and feature metadata select the existing blocking profile owner', () => {
  expect(needsSharedNative(['checks/native-shared-wasm-memory.json'])).toBe(true);
  expect(needsSharedNative(['crates/bunwasm-runtime/src/wasm/nested.rs'])).toBe(true);
  expect(needsSharedNative(['tests/fixtures/shared-wasm-memory/index.ts'])).toBe(true);
  expect(needsSharedNative(['site/style.css'])).toBe(false);
});

for (const path of sharedNativeFiles) {
  test(`shared producer input ${path} selects its consumer and launcher`, () => {
    expect(needsSharedNative([path])).toBe(true);
    expect(needsRust([path])).toBe(true);
  });
}

test.each([
  'scripts/sync-bun.sh', 'scripts/sync-crypto.sh', 'scripts/transpile-runtime.ts',
  'scripts/generate-bun-wrap.ts', 'scripts/generate-node-path.ts', 'scripts/generate-direct-stream.ts',
  'web/src/native-direct-stream.ts', 'src/engine-kind.ts',
  'jsc/wasi-jsc.cmake', 'scripts/check-cmake-cache.cmake',
])('shared core input %s selects the consumer and launcher', path => {
  expect(needsSharedNative([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
});

test.each([
  'crates/bunwasm-runtime/src/js/runtime.d.ts',
  'crates/bunwasm-engine-hermes/src/vm.rs',
  'scripts/build-engine-hermes.sh', 'scripts/build-bun-hermes.sh',
  'checks/native-hermes-smoke.json',
])('unrelated profile or type-only input %s keeps shared native skipped', path => {
  expect(needsSharedNative([path])).toBe(false);
});

const sharedBrowserInputs = [
  'web/src/runner.ts', 'web/src/worker.ts', 'web/src/subprocess-broker.ts',
  'web/src/memory-telemetry.ts', 'web/src/net/trampoline.ts', 'web/src/engine-loader.ts',
  'web/src/preview1-worker.ts', 'web/src/fs-worker.ts', 'web/src/notification-worker.ts',
  'src/assets.ts', 'src/program-memory.ts', 'src/bun-adapter.ts', 'src/process-runtime.ts',
  'src/executable-paths.ts', 'src/guest-asset.generated.ts', 'src/shared-objects.ts',
  'scripts/browser-build.ts', 'scripts/base-program-build.ts', 'scripts/bash-web-guests.ts',
  'web/package.json', 'web/bun.lock',
];
test.each(sharedBrowserInputs)('shared Browser dependency %s selects the consumer and its launcher', path => {
  expect(needsSharedNative([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
});
