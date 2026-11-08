import { expect, test } from 'bun:test';
import { checkArguments, checkCommand, parseCheck, selectChecks } from './test-checks.ts';
import { profileArtifacts } from './native-profile-fixtures.ts';
import { needsSharedNative } from './ci-changes.ts';

const split = parseCheck({ owner: 'native', path: 'tests/fixtures/regular' }, 'native-regular.json');
const shared = parseCheck({ owner: 'native', path: 'tests/fixtures/shared', profile: 'shared-group' }, 'native-shared.json');

test('ordinary native selection and command stay split while shared selection is explicit', () => {
  expect(selectChecks('native', [split, shared])).toEqual(['tests/fixtures/regular']);
  expect(selectChecks('native', [split, shared], 'shared-group')).toEqual(['tests/fixtures/shared']);
  expect(checkCommand('native', ['tests/fixtures/regular']).slice(-1)).toEqual(['regular']);
  expect(checkCommand('native', ['tests/fixtures/shared'], 'shared-group').slice(-2)).toEqual([expect.stringContaining('native-profile-fixtures.ts'), 'tests/fixtures/shared']);
});

test('profile manifests reject unknown values and unrelated owners', () => {
  for (const profile of [null, true, '', 'threaded', 'shared', 'browser']) {
    expect(() => parseCheck({ owner: 'native', path: 'tests/fixtures/shared', profile }, 'native-shared.json')).toThrow();
  }
  expect(() => parseCheck({ owner: 'quality', path: 'scripts/example.test.ts', profile: 'shared-group' }, 'quality-example.json')).toThrow();
  expect(parseCheck({ owner: 'native', path: 'tests/fixtures/regular', profile: 'split' }, 'native-regular.json')).toEqual(split);
});

test('CLI profile selection is closed and missing group artifacts fail', () => {
  expect(checkArguments(['native', '--profile', 'shared-group', '--list'])).toEqual({ owner: 'native', profile: 'shared-group', list: true });
  expect(checkArguments(['native', '--list'])).toEqual({ owner: 'native', profile: 'split', list: true });
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
