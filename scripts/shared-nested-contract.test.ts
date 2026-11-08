import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sharedGroupEnvironment } from './src/program-profile.ts';

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('shared execution is a matching group profile, not the ordinary split route', () => {
  const environment = sharedGroupEnvironment('/qualified/shared-pic', 'quickjs');
  expect(environment.BUN_WASM_PROGRAM_PROFILE).toBe('shared-group');
  expect(environment.CFLAGS_wasm32_wasip1).toContain('-matomics');
  expect(source('third_party/rquickjs-sys/build.rs')).toContain('defines.push(("BUN_WASM_SHARED_GROUP"');
  const native = source('crates/bunwasm-runtime/src/wasm/nested.rs');
  expect(native).toContain('bunwasm_nested::regionize(bytes)');
  expect(source('crates/bunwasm-runtime/src/wasm.rs')).toContain('#[cfg(bun_wasm_shared_group)]\nmod nested;');
  expect(source('crates/bunwasm-runtime/src/wasm.rs')).toContain('Shared WebAssembly memories require the shared-group profile');
  expect(source('crates/bunwasm-engine-quickjs/src/nested_bridge.rs')).toContain('thrown: RefCell<Option<Value');
  expect(source('crates/bunwasm-runtime/src/wasm/nested_wire.rs')).not.toContain('Engine::Value');
});

test('the native semantic control covers the same real module bytes without claiming guest coverage', () => {
  const fixture = resolve(import.meta.dir, '../tests/fixtures/shared-wasm-memory/index.ts');
  const result = Bun.spawnSync([process.execPath, fixture], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toBe('shared-wasm-memory: pass\n');
});

test('shared fixtures cannot silently become an ordinary split passing skip', () => {
  const status: unknown = JSON.parse(source('tests/fixtures/shared-wasm-memory/fixture.json'));
  expect(status).toMatchObject({ status: 'shared-profile-blocking' });
  const runner = source('scripts/shared-nested-native.ts');
  expect(runner).toContain('real-quickjs-shared-group-native');
  expect(source('scripts/native-profile-fixtures.ts')).toContain('output differs from expected.txt');
  expect(runner).not.toMatch(/\bskip\(/);
});
