import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsRust, needsSharedNative } from './ci-changes.ts';
import { discoverChecks, selectChecks } from './test-checks.ts';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const shared = workflow.split('\n  shared-sysroot:\n')[1]!.split('\n  web:\n')[0]!;
const libraryProducer = workflow.split('\n  shared-spidermonkey-prebuild:\n')[1]!.split('\n  shared-sysroot:\n')[0]!;

function step(name: string): string {
  const result = workflow.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
  assert(result, `missing workflow step: ${name}`);
  return result;
}

for (const path of [
  'spidermonkey/common.sh', 'spidermonkey/fetch-spidermonkey.sh', 'spidermonkey/build-shared-group.sh',
  'spidermonkey/shared-group.ts', 'spidermonkey/native-profile.ts', 'spidermonkey/mozconfig.in',
  'spidermonkey/spidermonkey-wasi.patch', 'spidermonkey/spidermonkey-shared-group.patch',
  'spidermonkey/patch-lifecycle.sh', 'spidermonkey/irregexp-icu/allocator.cpp',
  'scripts/build-engine-spidermonkey-shared.sh', 'scripts/spidermonkey-side-core-receipt.ts',
  'crates/bunwasm-spidermonkey/build.rs', 'crates/bunwasm-engine-spidermonkey/src/vm.rs',
  'checks/quality-spidermonkey-shared-ci.json', 'scripts/build-native-profile.test.ts',
  'scripts/spidermonkey-native-qualification.ts', 'scripts/spidermonkey-native-qualification.test.ts', 'checks/quality-spidermonkey-native-qualification.json',
]) test(`SM input ${path} selects the blocking shared producer and native launcher`, () => {
  expect(needsSharedNative([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
});

test('SM uses the existing discovered fixture and blocking owner, not a Browser campaign', () => {
  expect(selectChecks('native', undefined, 'shared-group')).toContain('tests/fixtures/shared-wasm-memory');
  expect(discoverChecks().filter(check => check.path === 'scripts/build-native-profile.test.ts')).toHaveLength(1);
  expect(discoverChecks().filter(check => check.path === 'scripts/spidermonkey-shared-ci.test.ts')).toHaveLength(1);
  const consumer = step('Consume the shared SpiderMonkey native feature checks');
  expect(consumer).toContain("if: needs.quality.outputs.shared-native == 'true'");
  expect(consumer).toContain('bun scripts/test-checks.ts native --profile shared-group');
  expect(consumer).toContain('program-spidermonkey/bun.wasm');
  expect(consumer).toContain('native-profile-launcher/bun-wasm');
  expect(consumer).not.toMatch(/browser-guest|continue-on-error|BUN_WASM_SPIDERMONKEY_TIER|test -[ef]/);
  expect(shared).not.toContain('shared-wasm-memory');
  expect(shared).toContain('timeout-minutes: 30');
});

test('SM has one library producer and one side consumer and never builds another common core', () => {
  expect(workflow.match(/bash spidermonkey\/build-shared-group.sh/g)).toHaveLength(1);
  expect(workflow.match(/bun scripts\/build-native-profile.ts shared-group "\$CARGO_TARGET_DIR\/shared-native" spidermonkey/g)).toHaveLength(1);
  expect(shared).not.toContain('bash scripts/build-engine-spidermonkey-shared.sh');
  expect(shared).not.toContain('bash jsc/build-libcxx.sh');
  expect(shared).not.toContain('bash scripts/build-bun-core.sh');
  expect(shared).toContain('SPIDERMONKEY_LIBCXX_DIR=$JSC_BUILD_DIR/libcxx/lib');
  const profile = readFileSync(new URL('./build-native-profile.ts', import.meta.url), 'utf8');
  const sm = profile.split('async function buildSpiderMonkeyProfile(')[1]!.split('\nexport async function buildNativeProfile(')[0]!;
  expect(sm).not.toContain('build-bun-core.sh');
  expect(sm.match(/run\(\['bash', 'scripts\/build-engine-spidermonkey-shared.sh'\]\)/g)).toHaveLength(1);
  expect(sm).toContain('verifyProgramReceipt');
  expect(sm).toContain('assert.deepEqual(await capture(), inputs');
});

test('SM caches exact source and native work and replays patch and library verification on a hit', () => {
  const cache = libraryProducer.split('        id: shared-spidermonkey-cache\n')[1]!.split('\n      - ')[0]!;
  expect(cache).toContain('path: ${{ runner.temp }}/spidermonkey/shared');
  expect(cache).toContain('spidermonkey-shared-group-v2-');
  for (const input of ['steps.shared-spidermonkey-inputs.outputs.hash', 'steps.shared-spidermonkey-inputs.outputs.recipes']) expect(cache).toContain(input);
  expect(cache).not.toContain('restore-keys:');
  const producer = step('Produce or verify the shared SpiderMonkey library once');
  expect(producer).toContain('config remote.origin.promisor true');
  expect(producer).toContain('config remote.origin.partialclonefilter blob:none');
  expect(producer).toContain('rm -rf -- "$SPIDERMONKEY_BUILD_DIR/native"');
  expect(producer).not.toMatch(/cache-hit|git .* reset|git .* clean/);
  expect(step('Save the verified shared SpiderMonkey source and native work')).toContain("success() && !cancelled() && github.event_name == 'push'");
});

test('SM retains the complete matched program, native receipts and source identity', () => {
  const artifact = step('Retain the matched shared SpiderMonkey program for qualification');
  for (const value of ['shared-spidermonkey-producer.outcome == \'success\'', 'program-spidermonkey/', 'spidermonkey/inputs.json', 'spidermonkey/engine-link.map', 'SPIDERMONKEY_BUILD_DIR }}/receipt/', 'if-no-files-found: error']) expect(artifact).toContain(value);
});

function command(name: string): string {
  const body = step(name).split('        run: |\n')[1];
  assert(body);
  return body.split('\n').map(line => line.slice(10)).join('\n');
}

test('the SM producer isolates Python from ambient packages and clears restored environments', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-sm-python-'));
  try {
    const parent = join(root, 'parent');
    const clean = join(root, 'spidermonkey-python');
    for (const path of [parent, clean]) {
      const setup = spawnSync('python3', ['-m', 'venv', '--without-pip', path], { encoding: 'utf8' });
      expect(setup.status, setup.stderr).toBe(0);
      const poison = spawnSync(join(path, 'bin/python3'), ['-c',
        'import pathlib,sysconfig; p=pathlib.Path(sysconfig.get_path("purelib"))/"ambient_ci_poison-1.0.dist-info"; p.mkdir(); (p/"METADATA").write_text("Metadata-Version: 2.1\\nName: ambient-ci-poison\\nVersion: 1.0\\nRequires-Dist: absent-ci-dependency\\n")',
      ], { encoding: 'utf8' });
      expect(poison.status, poison.stderr).toBe(0);
    }
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(root, 'env.sh'), '');
    writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'bash'), `#!/bin/sh
exec python3 -c 'import importlib.metadata,sys; print(sys.prefix); print(sorted(d.metadata["Name"] for d in importlib.metadata.distributions()))'
`, { mode: 0o755 });
    const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', command('Produce or verify the shared SpiderMonkey library once')], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${parent}/bin:${process.env.PATH}`, RUNNER_TEMP: root, SPIDERMONKEY_BUILD_DIR: join(root, 'source') },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([clean, '[]']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real workflow steps wire the library, existing core, side and discovered consumer exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-sm-ci-recorder-'));
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(root, 'env.sh'), 'export PATH="$RECORDER_BIN:$PATH"\n');
    const recorder = '#!/bin/sh\nprintf "%s" "${0##*/}" >> "$RECORD"\nprintf " <%s>" "$@" >> "$RECORD"\nprintf "\\n" >> "$RECORD"\n';
    for (const name of ['git', 'bash', 'bun']) writeFileSync(join(bin, name), recorder, { mode: 0o755 });
    const env = { ...process.env, RECORD: join(root, 'record'), RECORDER_BIN: bin, SPIDERMONKEY_BUILD_DIR: join(root, 'sm'),
      SPIDERMONKEY_NATIVE_DIR: join(root, 'sm/native'), SPIDERMONKEY_LIBCXX_DIR: join(root, 'jsc/libcxx/lib'), CARGO_TARGET_DIR: join(root, 'target'), RUNNER_TEMP: root };
    const commands = ['Produce or verify the shared SpiderMonkey library once', 'Produce the shared SpiderMonkey profile once', 'Consume the shared SpiderMonkey native feature checks'];
    const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', commands.map(command).join('\n')], { cwd: root, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(env.RECORD, 'utf8').trim().split('\n');
    expect(calls.filter(line => line.startsWith('bash '))).toEqual(['bash <spidermonkey/build-shared-group.sh>']);
    expect(calls.filter(line => line.startsWith('bun '))).toEqual([
      `bun <scripts/build-native-profile.ts> <shared-group> <${env.CARGO_TARGET_DIR}/shared-native> <spidermonkey>`,
      'bun <scripts/test-checks.ts> <native> <--profile> <shared-group>',
    ]);
    expect(calls.filter(line => line.includes('remote.origin.promisor'))).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('the discovered native consumer qualifies both SM tiers without a second producer or a changed clock', () => {
  const driver = readFileSync(new URL('./native-profile-fixtures.ts', import.meta.url), 'utf8');
  expect(driver).toContain("artifacts.engine === 'spidermonkey'");
  expect(driver).toContain('spiderMonkeyTiers.map(tier => runFixture(id, directory, artifacts, env, tier))');
  expect(driver).toContain('verifySpiderMonkeyQualification(result.stderr, tier)');
  expect(driver).toContain('const COMMAND_TIMEOUT_MS = 120_000');
  expect(driver).toContain('timeout: COMMAND_TIMEOUT_MS');
  expect(driver).toContain('result.stdout !== expected');
  expect(driver).toContain("process.stderr.write(result.stderr ?? '')");
  expect(driver).not.toMatch(/build-native|build-bun|build-engine|\.replace\(|\.filter\(/);
  expect(discoverChecks().filter(check => check.path === 'scripts/spidermonkey-native-qualification.test.ts')).toHaveLength(1);
});
