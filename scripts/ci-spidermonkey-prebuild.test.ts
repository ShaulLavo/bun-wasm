import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsRust, needsSharedNative } from './ci-changes.ts';
import { sharedSpiderMonkeyRecipes, verifyPrebuild, writePrebuild } from './ci-spidermonkey-prebuild.ts';
import { selectChecks } from './test-checks.ts';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
function job(name: string): string {
  const result = workflow.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
  assert(result);
  return result;
}
function command(jobName: string, name: string): string {
  const result = job(jobName).split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0]?.split('        run: ')[1];
  assert(result);
  return result.startsWith('|\n') ? result.slice(2).split('\n').map(line => line.slice(10)).join('\n') : result.trim();
}

const producer = job('shared-spidermonkey-prebuild');
const consumer = job('shared-sysroot');

test('one bounded SM library prebuild feeds the original blocking owner and all unchanged consumers', () => {
  expect(producer).toContain('needs: [selection, shared-prebuild]');
  expect(producer).toContain("needs.selection.outputs.shared-native == 'true'");
  expect(producer).toContain('timeout-minutes: 30');
  expect(producer).not.toMatch(/build-native-profile|build-bun-core|build-engine|test-checks|build-libcxx/);
  expect(consumer).toContain('needs: [selection, rust, shared-prebuild, shared-spidermonkey-prebuild]');
  expect(consumer).toContain('!cancelled() && needs.selection.result');
  expect(consumer).toContain('timeout-minutes: 30');
  expect(consumer).not.toContain('spidermonkey/build-shared-group.sh');
  expect(consumer).not.toContain('id: shared-spidermonkey-cache');
  for (const name of ['Consume the shared native feature checks', 'Consume the shared Browser feature checks',
    'Consume the shared JSC feature checks', 'Consume the shared SpiderMonkey native feature checks', 'Consume the shared SpiderMonkey Browser feature checks']) {
    expect(workflow.match(new RegExp(`name: ${name}\\n`, 'g'))).toHaveLength(1);
    expect(consumer).toContain(`name: ${name}\n`);
  }
  expect(command('shared-spidermonkey-prebuild', 'Import only the verified shared sysroot for SpiderMonkey')).not.toContain('tar --posix -xOf "$transfer" prebuild.tar.zst |');
  const upload = producer.split('          name: shared-spidermonkey-prebuild\n')[1]!.split('      - name:')[0]!;
  for (const path of ['/native/', '/receipt/', '/prebuild.json']) expect(upload).toContain(path);
  expect(upload).not.toMatch(/firefox|\/obj\/|\/target\//);
  for (const name of ['Configure private shared sysroot paths', 'Install pinned shared build tools', 'Install pinned WASI SDK']) {
    expect(command('shared-spidermonkey-prebuild', name)).toBe(command('shared-prebuild', name));
  }
});

test.each(['failure', 'cancelled', 'skipped'])('a selected %s SM producer fails SharedPIC before linking', result => {
  const guard = command('shared-sysroot', 'Require the shared SpiderMonkey library producer');
  expect(spawnSync('bash', ['-euo', 'pipefail', '-c', guard], { env: { ...process.env, SM_PREBUILD_RESULT: result } }).status).not.toBe(0);
  expect(consumer.indexOf('name: Require the shared SpiderMonkey library producer')).toBeLessThan(consumer.indexOf('name: Produce the shared native profile once'));
});

test('successful SM production is admitted and an unselected SM prebuild leaves the libc proof running', () => {
  const guard = command('shared-sysroot', 'Require the shared SpiderMonkey library producer');
  expect(spawnSync('bash', ['-euo', 'pipefail', '-c', guard], { env: { ...process.env, SM_PREBUILD_RESULT: 'success' } }).status).toBe(0);
  expect(consumer).toContain("(needs.selection.outputs.shared == 'true' || needs.selection.outputs.shared-native == 'true')");
  expect(consumer.split('name: Require the shared SpiderMonkey library producer\n')[1]).toStartWith("        if: needs.selection.outputs.shared-native == 'true'\n");
  expect(consumer).toContain('bash scripts/test-shared-sysroot.sh');
});

test.each(['scripts/ci-spidermonkey-prebuild.ts', 'scripts/ci-spidermonkey-prebuild.test.ts', 'checks/quality-ci-spidermonkey-prebuild.json'])('%s selects both original owners', path => {
  expect(needsSharedNative([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
  expect(selectChecks('quality')).toContain('scripts/ci-spidermonkey-prebuild.test.ts');
});

test('exact cache identity covers recipes, tool bytes, pinned SDK and native host packages', () => {
  const identify = command('shared-spidermonkey-prebuild', 'Identify shared SpiderMonkey native inputs');
  for (const input of ['bun-wasm-sysroot.json', 'libc.a', 'bin/clang++', 'bin/cbindgen', 'sha256sum "$(command -v "$tool")"', 'dpkg-query -W', 'rustc -vV']) expect(identify).toContain(input);
  expect(sharedSpiderMonkeyRecipes()).toMatch(/^[0-9a-f]{64}$/);
  expect(producer).not.toContain('restore-keys:');
  expect(producer).toContain('spidermonkey-shared-group-v2-');
});

function restoreEnvironment(before: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function fixture(run: (value: { root: string; received: string; sysroot: string; digest: string }) => void) {
  const scratch = mkdtempSync(join(tmpdir(), 'bun-wasm-sm-transfer-'));
  const before = { GITHUB_RUN_ID: process.env.GITHUB_RUN_ID, GITHUB_SHA: process.env.GITHUB_SHA };
  try {
    process.env.GITHUB_RUN_ID = '123';
    process.env.GITHUB_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const root = join(scratch, 'producer'), received = join(scratch, 'consumer'), sysroot = join(scratch, 'sysroot');
    for (const path of ['native/include', 'receipt', 'obj', 'firefox']) mkdirSync(join(root, path), { recursive: true });
    for (const path of ['native/shared-group-library.json', 'receipt/shared-group-library.json', 'receipt/headers.json',
      'native/libspidermonkey_bunwasm.a', 'native/js-confdefs.h', 'native/include/js.h']) writeFileSync(join(root, path), path.endsWith('shared-group-library.json') ? 'same receipt' : path);
    mkdirSync(join(sysroot, 'lib/wasm32-wasip1'), { recursive: true });
    writeFileSync(join(sysroot, 'lib/wasm32-wasip1/libc.a'), 'fixture libc');
    writeFileSync(join(sysroot, 'bun-wasm-sysroot.json'), JSON.stringify({ profile: 'shared-pic', growthImport: 'runtime_shm.group_grow',
      flags: '-fPIC -matomics -mbulk-memory -mmutable-globals -DMORECORE_CONTIGUOUS=0 -DBUN_WASM_GROUP_HEAP=1',
      libcSha256: hash('fixture libc'), sharedBuilderSha256: 'a'.repeat(64), groupGrowPatchSha256: 'b'.repeat(64) }));
    const digest = writePrebuild(root, sysroot, 'a'.repeat(64));
    mkdirSync(received);
    for (const path of ['native', 'receipt', 'prebuild.json']) cpSync(join(root, path), join(received, path), { recursive: true });
    run({ root, received, sysroot, digest });
  } finally {
    restoreEnvironment(before);
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('the exact archive/header/receipt closure survives transfer without source or object trees', () => fixture(({ received, sysroot, digest }) => {
  expect(() => verifyPrebuild(received, sysroot, digest)).not.toThrow();
}));

test.each(['native/libspidermonkey_bunwasm.a', 'native/include/js.h', 'native/js-confdefs.h', 'receipt/headers.json'])('changed %s fails before side linking', path => fixture(({ received, sysroot, digest }) => {
  writeFileSync(join(received, path), 'changed');
  expect(() => verifyPrebuild(received, sysroot, digest)).toThrow('bytes or file closure changed');
}));

test.each(['run', 'source', 'tree', 'recipes', 'sharedSysroot'])('a self-consistent foreign %s receipt fails source admission', field => fixture(({ received, sysroot }) => {
  const path = join(received, 'prebuild.json');
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert(manifest && typeof manifest === 'object');
  Reflect.set(manifest, field, 'foreign');
  const raw = JSON.stringify(manifest);
  writeFileSync(path, raw);
  expect(() => verifyPrebuild(received, sysroot, hash(raw))).toThrow(`${field} changed`);
}));

test('missing producer identity, links, missing headers and extra closure files fail closed', () => fixture(({ root, received, sysroot, digest }) => {
  expect(() => verifyPrebuild(received, sysroot, '')).toThrow('Missing producer manifest');
  expect(() => verifyPrebuild(received, sysroot, 'b'.repeat(64))).toThrow('manifest changed');
  writeFileSync(join(received, 'native/extra'), 'extra');
  expect(() => verifyPrebuild(received, sysroot, digest)).toThrow('file closure changed');
  rmSync(join(received, 'native/extra'));
  rmSync(join(received, 'native/include/js.h'));
  expect(() => verifyPrebuild(received, sysroot, digest)).toThrow('file closure changed');
  symlinkSync(join(root, 'native/include/js.h'), join(received, 'native/include/js.h'));
  expect(() => verifyPrebuild(received, sysroot, digest)).toThrow('link or special file');
}));
