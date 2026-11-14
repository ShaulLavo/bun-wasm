import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNativeProfile, nativeProfileEngine, spiderMonkeyNativeInputs, spiderMonkeySources } from './build-native-profile.ts';
import { hash } from './guest-source-manifest.ts';
import { groupFlags } from '../spidermonkey/shared-group.ts';
import { pin } from '../spidermonkey/native-profile.ts';
import { verifySharedSysroot } from './src/program-profile.ts';
import { profileArtifacts, runDeclaredFixtures, runProfileFixtures } from './native-profile-fixtures.ts';
import { appendCustomSection, tagProgramCore } from '../src/engine-kind.ts';

const text = (value: string) => [value.length].concat(Array.from(value, character => character.charCodeAt(0)));
const section = (id: number, payload: number[]) => [id, payload.length].concat(payload);
const header = [0, 97, 115, 109, 1, 0, 0, 0];

test.each(['1', '', 'true'])('normal SM production refuses validation selection %j before reading inputs', async value => {
  const previous = process.env.SPIDERMONKEY_TRANSFER_FAULT;
  process.env.SPIDERMONKEY_TRANSFER_FAULT = value;
  try { await expect(buildNativeProfile('shared-group', '/unused', 'spidermonkey')).rejects.toThrow('SPIDERMONKEY_TRANSFER_FAULT=0'); }
  finally {
    if (previous === undefined) delete process.env.SPIDERMONKEY_TRANSFER_FAULT;
    else process.env.SPIDERMONKEY_TRANSFER_FAULT = previous;
  }
});

test('shared SM capture includes each borrowed validation source', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-sm-shared-sources-'));
  const paths = ['crates/bunwasm-engine-quickjs/build/transfer_fault.rs', 'crates/bunwasm-engine-quickjs/src/transfer_fault.rs', 'scripts/src/transfer-fault.sh'];
  try {
    for (const path of paths) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), 'first\n');
    }
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    expect(spiderMonkeySources(root).map(source => source.path)).toEqual(paths);
    for (const path of paths) {
      const before = spiderMonkeySources(root);
      writeFileSync(join(root, path), 'changed\n');
      expect(spiderMonkeySources(root)).not.toEqual(before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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


/** A launcher that records its arguments and tier, and prints what the selected command is expected to print. */
const recordingLauncher = [
  '#!/bin/sh',
  'printf "%s\\n" "${BUN_WASM_SPIDERMONKEY_TIER:-none} $*" >> "$RECORDER_ARGS"',
  'case "$*" in *lifetime.ts) name=lifetime; printf "%s" "$RECORDER_LIFETIME";; *) name=default; printf "%s" "$RECORDER_DEFAULT";; esac',
  'entries=0; if [ "$BUN_WASM_SPIDERMONKEY_TIER" = pbl ]; then entries=9; fi',
  'printf "bun-wasm spidermonkey: stack_low=0x7a0000 stack_high=0xfa0000 stack_bytes=8388608 register_depth=16 entry_depth=1392 interrupt_polls=123 portable_baseline_entries=%s\\n" "$entries" >&2',
  'printf "%s\\n" "bun-wasm nested resources: {}" "bun-wasm group before physical stop: GroupSnapshot {}" >&2',
  'printf "%s\\n" "bun-wasm group after physical stop: GroupSnapshot { members: 0, reserved: 0, retained: 0, regions: 0, pins: 0, holds: 0, watches: 0, waiters: 0, committed_bytes: 166002688, free_bytes: 165937152, bypassed: false, published: 0 }" >&2',
  'if [ "$RECORDER_FAIL" = "$name" ]; then exit 3; fi',
].join('\n') + '\n';

test('each command of a fixture runs once per tier with its own files, and either one failing fails the run', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-native-entry-'));
  try {
    const path = 'tests/fixtures/pair';
    const fixture = join(root, path);
    mkdirSync(fixture, { recursive: true });
    const files = { cmd: 'run\n/default.ts\n', 'expected.txt': 'default\n', 'cmd.lifetime': 'run\n/lifetime.ts\n', 'expected.lifetime.txt': 'lifetime\n' };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(fixture, name), text);
    const launcher = join(root, 'launcher');
    const record = join(root, 'record');
    writeFileSync(launcher, recordingLauncher, { mode: 0o755 });
    const ids = [path, `${path}#lifetime`];
    const env: NodeJS.ProcessEnv = { ...process.env, RECORDER_ARGS: record, RECORDER_DEFAULT: 'default\n', RECORDER_LIFETIME: 'lifetime\n', RECORDER_FAIL: '' };
    const calls = () => { const lines = readFileSync(record, 'utf8').trim().split('\n'); rmSync(record); return lines; };
    const quickjs = { program: join(root, 'bun.wasm'), launcher, engine: 'quickjs' as const };
    const results = runDeclaredFixtures(ids, ids, root, quickjs, env);
    expect(results.map(result => [result.id, result.path, result.entry, result.tier])).toEqual([[path, path, null, null], [`${path}#lifetime`, path, 'lifetime', null]]);
    expect(results.every(result => result.wallMs >= 0)).toBe(true);
    // One launch each, an argument vector ending in that command's own lines.
    expect(calls().map(line => line.split(' -- ')[1])).toEqual(['run /default.ts', 'run /lifetime.ts']);
    // SpiderMonkey runs each command in each tier, and neither twice within one.
    const spidermonkey = { ...quickjs, engine: 'spidermonkey' as const };
    const tiered = runDeclaredFixtures(ids, ids, root, spidermonkey, env);
    expect(tiered.map(result => `${result.id} ${result.tier}`)).toEqual([`${path} interp`, `${path} pbl`, `${path}#lifetime interp`, `${path}#lifetime pbl`]);
    expect(calls().map(line => `${line.split(' ')[0]} ${line.split(' -- ')[1]}`)).toEqual(['interp run /default.ts', 'pbl run /default.ts', 'interp run /lifetime.ts', 'pbl run /lifetime.ts']);
    // Each command is held to its own expected output and its own exit status.
    env.RECORDER_LIFETIME = 'default\n';
    expect(() => runDeclaredFixtures(ids, ids, root, quickjs, env)).toThrow(`${path}#lifetime: shared native output differs from expected.lifetime.txt`);
    env.RECORDER_LIFETIME = 'lifetime\n'; env.RECORDER_DEFAULT = 'lifetime\n';
    expect(() => runDeclaredFixtures(ids, ids, root, quickjs, env)).toThrow(`${path}: shared native output differs from expected.txt`);
    env.RECORDER_DEFAULT = 'default\n'; env.RECORDER_FAIL = 'lifetime';
    expect(() => runDeclaredFixtures(ids, ids, root, quickjs, env)).toThrow(`${path}#lifetime: guest failed with 3`);
    env.RECORDER_FAIL = '';
    rmSync(record, { force: true });
    // Nothing undeclared, repeated or empty is launched.
    for (const selection of [[`${path}#other`], [path, path], [], [`${path}#lifetime`, `${path}#../x`]]) {
      expect(() => runDeclaredFixtures(selection, ids, root, quickjs, env)).toThrow('empty, repeated or undeclared');
    }
    // An entry file that is not a regular file of the fixture is refused before any launch.
    rmSync(join(fixture, 'cmd.lifetime'));
    symlinkSync(join(fixture, 'cmd'), join(fixture, 'cmd.lifetime'));
    expect(() => runDeclaredFixtures([`${path}#lifetime`], ids, root, quickjs, env)).toThrow('needs cmd.lifetime');
    expect(() => readFileSync(record)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the native CLI runs one SM pair on both actual tiers and preserves all stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-sm-tier-cli-'));
  try {
    const program = join(root, 'bun.wasm');
    const launcher = join(root, 'bun-wasm');
    const record = join(root, 'record');
    writeFileSync(program, pairCore());
    writeFileSync(join(root, 'spidermonkey-engine.wasm'), pairSide(true));
    const script = [
      '#!/bin/sh',
      'printf "%s\\n" "$BUN_WASM_SPIDERMONKEY_TIER $BUN_WASM_SPIDERMONKEY_TRACE $BUN_WASM_TRACE $*" >> "$RECORDER_ARGS"',
      'cat "$RECORDER_EXPECTED"',
      'entries=0; if [ "$BUN_WASM_SPIDERMONKEY_TIER" = pbl ]; then entries=9; fi',
      'if [ "$RECORDER_MODE" = missing ]; then exit 0; fi',
      'if [ "$RECORDER_MODE" = mismatched ]; then entries=1; fi',
      'printf "unrelated stderr %s\\n" "$BUN_WASM_SPIDERMONKEY_TIER" >&2',
      'printf "bun-wasm spidermonkey: stack_low=0x7a0000 stack_high=0xfa0000 stack_bytes=8388608 register_depth=16 entry_depth=1392 interrupt_polls=123 portable_baseline_entries=%s\\n" "$entries" >&2',
      'printf "%s\\n" "bun-wasm nested resources: {}" "bun-wasm group before physical stop: GroupSnapshot {}" >&2',
      'printf "%s\\n" "bun-wasm group after physical stop: GroupSnapshot { members: 0, reserved: 0, retained: 0, regions: 0, pins: 0, holds: 0, watches: 0, waiters: 0, committed_bytes: 166002688, free_bytes: 165937152, bypassed: false, published: 0 }" >&2',
    ].join('\n');
    writeFileSync(launcher, script + '\n', { mode: 0o755 });
    const env = { ...process.env, BUN_WASM_PROFILE_PROGRAM: program, BUN_WASM_LAUNCHER: launcher,
      BUN_WASM_SPIDERMONKEY_TIER: 'ignored ambient selector', RECORDER_ARGS: record, RECORDER_MODE: 'pass',
      RECORDER_EXPECTED: join(import.meta.dir, '../tests/fixtures/shared-wasm-memory/expected.txt') };
    const run = () => spawnSync(process.execPath, [join(import.meta.dir, 'native-profile-fixtures.ts'), 'tests/fixtures/shared-wasm-memory'], { env, encoding: 'utf8' });
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(record, 'utf8').trim().split('\n');
    expect(calls).toHaveLength(2);
    for (const [index, tier] of ['interp', 'pbl'].entries()) {
      expect(calls[index]).toStartWith(`${tier} 1 1 --wasm ${program} `);
      expect(calls[index]).toContain(`--env BUN_WASM_SPIDERMONKEY_TIER=${tier} --env BUN_WASM_SPIDERMONKEY_TRACE=1 -- run /guest.ts`);
      expect(result.stderr).toContain(`unrelated stderr ${tier}\n`);
    }
    expect(result.stdout.match(/"returningMembers": 1/g)).toHaveLength(2);
    expect(result.stderr.split('\n').filter(Boolean)).toHaveLength(10);
    env.RECORDER_MODE = 'missing';
    expect(run().stderr).toContain('Missing SpiderMonkey tier-engagement trace');
    env.RECORDER_MODE = 'mismatched';
    expect(run().stderr).toContain('tier engagement mismatch');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
