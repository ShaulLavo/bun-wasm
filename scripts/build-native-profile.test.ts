import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNativeProfile, nativeProfileEngine, spiderMonkeyNativeInputs } from './build-native-profile.ts';
import { hash } from './guest-source-manifest.ts';
import { groupFlags } from '../spidermonkey/shared-group.ts';
import { pin } from '../spidermonkey/native-profile.ts';
import { verifySharedSysroot } from './src/program-profile.ts';
import { profileArtifacts, runProfileFixtures } from './native-profile-fixtures.ts';
import { appendCustomSection, tagProgramCore } from '../src/engine-kind.ts';

const text = (value: string) => [value.length].concat(Array.from(value, character => character.charCodeAt(0)));
const section = (id: number, payload: number[]) => [id, payload.length].concat(payload);
const header = [0, 97, 115, 109, 1, 0, 0, 0];

function archive(shared: boolean): Buffer {
  const features = shared ? ['+atomics', '+bulk-memory', '+mutable-globals'] : ['-shared-mem'];
  const payload = text('target_features').concat([features.length], features.flatMap(feature => [feature.charCodeAt(0)].concat(text(feature.slice(1)))));
  const object = Buffer.from(header.concat(section(0, payload)));
  const entry = 'test.o/'.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '644'.padEnd(8) + String(object.length).padEnd(10) + '`\n';
  return Buffer.concat([Buffer.from('!<arch>\n' + entry), object, Buffer.from(object.length % 2 ? '\n' : '')]);
}

function nativeInputs(root: string) {
  const sysroot = join(root, 'sysroot');
  const native = join(root, 'native');
  const libcxx = join(root, 'libcxx');
  mkdirSync(join(sysroot, 'lib/wasm32-wasip1'), { recursive: true });
  mkdirSync(join(native, 'include'), { recursive: true });
  mkdirSync(libcxx);
  writeFileSync(join(sysroot, 'lib/wasm32-wasip1/libc.a'), 'fixture libc');
  writeFileSync(join(sysroot, 'bun-wasm-sysroot.json'), JSON.stringify({ profile: 'shared-pic', growthImport: 'runtime_shm.group_grow',
    flags: '-fPIC -matomics -mbulk-memory -mmutable-globals -DMORECORE_CONTIGUOUS=0 -DBUN_WASM_GROUP_HEAP=1',
    libcSha256: hash('fixture libc'), sharedBuilderSha256: 'a'.repeat(64), groupGrowPatchSha256: 'b'.repeat(64) }));
  writeFileSync(join(native, 'include/js.h'), 'fixture header');
  writeFileSync(join(native, 'js-confdefs.h'), 'fixture configuration');
  const library = archive(true);
  writeFileSync(join(native, 'libspidermonkey_bunwasm.a'), library);
  for (const name of ['libc++.a', 'libc++abi.a']) writeFileSync(join(libcxx, name), library);
  const headers = [{ path: 'js.h', sha256: hash('fixture header') }];
  const receipt = { profile: 'shared-group', revision: pin, flags: groupFlags, sharedSysroot: verifySharedSysroot(sysroot),
    library: { sha256: hash(library), bytes: library.length }, confdefsSha256: hash('fixture configuration'),
    headers: { count: 1, sha256: hash(JSON.stringify(headers, null, 2) + '\n') },
    patches: ['spidermonkey-wasi.patch', 'spidermonkey-shared-group.patch'].map(path => ({ path, sha256: hash(readFileSync(join(import.meta.dir, '../spidermonkey', path))) })) };
  const save = () => writeFileSync(join(native, 'shared-group-library.json'), JSON.stringify(receipt));
  save();
  return { sysroot, native, libcxx, receipt, save };
}

function withInputs(run: (inputs: ReturnType<typeof nativeInputs>) => void) {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-sm-native-inputs-'));
  try { run(nativeInputs(root)); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test('native production supports only the explicit engines, including the SM experiment', async () => {
  expect(nativeProfileEngine()).toBe('quickjs');
  for (const engine of ['quickjs', 'jsc', 'spidermonkey']) expect(nativeProfileEngine(engine)).toBe(engine);
  for (const engine of [null, '', 'browser', 'hermes', 'spidermonkey-pbl', true]) {
    expect(() => nativeProfileEngine(engine)).toThrow('Unsupported');
    await expect(buildNativeProfile('shared-group', '/unused', engine)).rejects.toThrow('Unsupported');
  }
  await expect(buildNativeProfile('split', '/unused', 'spidermonkey')).rejects.toThrow('Split production');
});

test('SM staged native identity binds the actual archive, headers, patches, sysroot and C++ runtimes', () => {
  withInputs(({ native, libcxx, sysroot }) => {
    const inputs = spiderMonkeyNativeInputs(native, libcxx, sysroot);
    expect(inputs.archives.map(archive => archive.path)).toEqual(['libc++.a', 'libc++abi.a']);
    writeFileSync(join(native, 'libspidermonkey_bunwasm.a'), 'mixed archive');
    expect(() => spiderMonkeyNativeInputs(native, libcxx, sysroot)).toThrow('library bytes changed');
    writeFileSync(join(native, 'libspidermonkey_bunwasm.a'), archive(true));
    writeFileSync(join(native, 'include/js.h'), 'mixed header');
    expect(() => spiderMonkeyNativeInputs(native, libcxx, sysroot)).toThrow('headers changed');
  });
});

test.each(['libspidermonkey_bunwasm.a', 'shared-group-library.json', 'js-confdefs.h'])('SM refuses missing staged %s', name => {
  withInputs(({ native, libcxx, sysroot }) => {
    rmSync(join(native, name));
    expect(() => spiderMonkeyNativeInputs(native, libcxx, sysroot)).toThrow();
  });
});

test.each(['libc++.a', 'libc++abi.a'])('SM refuses a missing or split-profile %s', name => {
  withInputs(({ native, libcxx, sysroot }) => {
    rmSync(join(libcxx, name));
    expect(() => spiderMonkeyNativeInputs(native, libcxx, sysroot)).toThrow();
    writeFileSync(join(libcxx, name), archive(false));
    expect(() => spiderMonkeyNativeInputs(native, libcxx, sysroot)).toThrow(/without atomics|disallows/);
  });
});

test('SM refuses split native metadata, a different sysroot and a changed group patch', () => {
  withInputs(({ native, libcxx, sysroot, receipt, save }) => {
    receipt.profile = 'split'; save();
    expect(() => spiderMonkeyNativeInputs(native, libcxx, sysroot)).toThrow('Expected pinned shared-group');
    receipt.profile = 'shared-group'; receipt.sharedSysroot = { ...receipt.sharedSysroot, libcSha256: 'c'.repeat(64) }; save();
    expect(() => spiderMonkeyNativeInputs(native, libcxx, sysroot)).toThrow('different sysroot');
    receipt.sharedSysroot = verifySharedSysroot(sysroot); receipt.patches[1]!.sha256 = 'd'.repeat(64); save();
    expect(() => spiderMonkeyNativeInputs(native, libcxx, sysroot)).toThrow('patches changed');
  });
});

function pairCore(): Uint8Array<ArrayBuffer> {
  const bind = text('bun_core_bind_engine').concat([0, 0]);
  const core = Uint8Array.from(header.concat(section(1, [1, 0x60, 0, 0]), section(3, [1, 0]), section(7, [1].concat(bind)), section(10, [1, 2, 0, 0x0b])));
  return tagProgramCore(appendCustomSection(core, 'dylink.0', new Uint8Array()), 'spidermonkey');
}

function pairSide(shared: boolean): Uint8Array<ArrayBuffer> {
  const memory = text('env').concat(text('memory'), [2], shared ? [3, 1, 1] : [1, 1, 1]);
  return Uint8Array.from(header.concat(section(2, [1].concat(memory))));
}

test('the discovered native driver admits SM and fails for missing selected output or mixed halves', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-sm-native-pair-'));
  try {
    const program = join(root, 'bun.wasm');
    const side = join(root, 'spidermonkey-engine.wasm');
    const launcher = join(root, 'bun-wasm');
    writeFileSync(program, pairCore()); writeFileSync(side, pairSide(true)); writeFileSync(launcher, 'fixture launcher');
    const env = { BUN_WASM_PROFILE_PROGRAM: program, BUN_WASM_LAUNCHER: launcher };
    expect(profileArtifacts(env).engine).toBe('spidermonkey');
    writeFileSync(side, pairSide(false));
    expect(() => profileArtifacts(env)).toThrow('different program profiles');
    rmSync(side);
    expect(() => profileArtifacts(env)).toThrow();
    rmSync(program);
    expect(() => profileArtifacts(env)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('the real native fixture runner invokes the original command and rejects wrong or absent stdout', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-sm-native-command-'));
  try {
    const program = join(root, 'bun.wasm');
    const launcher = join(root, 'bun-wasm');
    const args = join(root, 'args');
    writeFileSync(program, pairCore());
    writeFileSync(join(root, 'spidermonkey-engine.wasm'), pairSide(true));
    writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\n" "$@" > "$RECORDER_ARGS"\nprintf "%s" "$RECORDER_STDOUT"\n', { mode: 0o755 });
    const env = { ...process.env, BUN_WASM_PROFILE_PROGRAM: program, BUN_WASM_LAUNCHER: launcher, RECORDER_ARGS: args, RECORDER_STDOUT: '' };
    expect(() => runProfileFixtures(['tests/fixtures/shared-wasm-memory'], env)).toThrow('output differs');
    const command = readFileSync(join(import.meta.dir, '../tests/fixtures/shared-wasm-memory/cmd'), 'utf8').trim().split('\n');
    expect(readFileSync(args, 'utf8').trim().split('\n').slice(-command.length)).toEqual(command);
    env.RECORDER_STDOUT = 'wrong fixture output\n';
    expect(() => runProfileFixtures(['tests/fixtures/shared-wasm-memory'], env)).toThrow('output differs');
    rmSync(program);
    expect(() => runProfileFixtures(['tests/fixtures/shared-wasm-memory'], env)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
