import { expandedCiWorkflow } from "./fixtures/ci-jsc-workflow";
import assert from 'node:assert/strict';
import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { needsRust, needsSharedNative } from './ci-changes.ts';
import { sharedSpiderMonkeyRecipes, verifyPrebuild, writePrebuild } from './ci-spidermonkey-prebuild.ts';
import { selectChecks } from './test-checks.ts';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const workflow = expandedCiWorkflow();
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

const recipeBindings = ['env.sh', 'Cargo.lock', 'rust-toolchain.toml', 'package.json', 'bun.lock',
  'spidermonkey/common.sh', 'spidermonkey/mozconfig.in', 'spidermonkey/build-shared-group.sh', 'spidermonkey/shared-group.ts',
  'spidermonkey/spidermonkey-wasi.patch', 'spidermonkey/spidermonkey-shared-group.patch',
  'crates/bunwasm-spidermonkey/build.rs', 'scripts/src/program-profile.ts', 'src/engine-kind.ts',
  'scripts/ci-spidermonkey-prebuild.ts', 'scripts/ci-bootstrap-tools.ts', 'scripts/ci-install.ts',
  'scripts/ci-stage-release-packages.ts', 'scripts/ci-release-download.ts', 'scripts/ci-build-tools.ts', 'scripts/waffle-release-inputs.json', 'scripts/build-wasi-sysroot.ts'];

function recipeFixture(run: (root: string, source: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-sm-recipe-'));
  try {
    for (const path of recipeBindings) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), `// fixture ${path}\n`);
    }
    cpSync('.github/actions', join(root, '.github/actions'), { recursive: true });
    mkdirSync(join(root, '.github/workflows'));
    const source = readFileSync('.github/workflows/ci.yml', 'utf8');
    writeFileSync(join(root, '.github/workflows/ci.yml'), source);
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'add', '.']);
    run(root, source);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('consumer supervision, routing and reports leave the compiled recipe unchanged', () => recipeFixture((root, source) => {
  const original = sharedSpiderMonkeyRecipes(root);
  const consumerCommand = 'bun scripts/run-with-timeout.mts 420 bun scripts/test-checks.ts browser-guest --profile shared-group';
  expect(source).toContain(consumerCommand);
  const supervision = "${{ matrix.engine == 'spidermonkey' && 660 || 420 }}";
  const before = source.replaceAll(consumerCommand, consumerCommand.replace('420', supervision));
  writeFileSync(join(root, '.github/workflows/ci.yml'), before);
  expect(sharedSpiderMonkeyRecipes(root)).toBe(original);
  const updated = before.replaceAll('&& 660 ||', '&& 1320 ||');
  expect(updated).not.toBe(before);
  writeFileSync(join(root, '.github/workflows/ci.yml'), updated);
  expect(sharedSpiderMonkeyRecipes(root)).toBe(original);
  const consumerStart = updated.indexOf('\n  shared-sysroot:\n');
  const consumer = updated.slice(consumerStart).replace('runs-on: ubuntu-latest', 'runs-on: [self-hosted, linux]')
    .replace('name: Shared PIC sysroot proof', 'name: Consumer report');
  expect(consumer).not.toBe(updated.slice(consumerStart));
  writeFileSync(join(root, '.github/workflows/ci.yml'), updated.slice(0, consumerStart) + consumer);
  expect(sharedSpiderMonkeyRecipes(root)).toBe(original);
}));

test.each(recipeBindings)('compiled recipe binds source, flags, patches and tool setup: %s', path => recipeFixture(root => {
  const original = sharedSpiderMonkeyRecipes(root);
  writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8') + '\n// changed input\n');
  expect(sharedSpiderMonkeyRecipes(root)).not.toBe(original);
}));

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  assert(isObject(value));
  return value;
}

function producerSteps(value: unknown): unknown[] {
  const producer = object(object(object(value).jobs)['shared-spidermonkey-prebuild']);
  assert(Array.isArray(producer.steps));
  return producer.steps;
}

test('every producer setup/build step and its environment remains part of the recipe', () => recipeFixture((root, source) => {
  const original = sharedSpiderMonkeyRecipes(root);
  const parsed: unknown = Bun.YAML.parse(source);
  const boundary = producerSteps(parsed).findIndex(step => object(step).id === 'shared-sm-artifact');
  expect(boundary).toBeGreaterThan(0);
  for (let index = 0; index < boundary; index++) {
    const changed = structuredClone(parsed);
    const steps = producerSteps(changed);
    const step = object(steps[index]);
    steps[index] = { ...step, env: { ...object(step.env ?? {}), CXXFLAGS: '-DCHANGED_PRODUCER=1' } };
    writeFileSync(join(root, '.github/workflows/ci.yml'), Bun.YAML.stringify(changed));
    expect(sharedSpiderMonkeyRecipes(root)).not.toBe(original);
  }
  for (const [before, after] of [
    ['bash spidermonkey/build-shared-group.sh', 'CXXFLAGS=-O0 bash spidermonkey/build-shared-group.sh'],
    ['CARGO_INCREMENTAL: "0"', 'CARGO_INCREMENTAL: "1"'],
    ['CI_NODE_VERSION: \'26.13.1\'', 'CI_NODE_VERSION: \'26.13.2\''],
    ['wasi-sdk-34.0-x86_64-linux', 'wasi-sdk-35.0-x86_64-linux'],
    ['JOBS: "2"', 'JOBS: "3"'],
  ] satisfies [string, string][]) {
    // Scope identical setup strings to the producer, except the global Node pin.
    const start = before.startsWith('CI_NODE_VERSION') ? 0 : source.indexOf('\n  shared-spidermonkey-prebuild:\n');
    const updated = source.slice(0, start) + source.slice(start).replace(before, after);
    expect(updated).not.toBe(source);
    writeFileSync(join(root, '.github/workflows/ci.yml'), updated);
    expect(sharedSpiderMonkeyRecipes(root)).not.toBe(original);
  }
}));

test('canonical YAML and producer metadata preserve identity; missing boundaries fail closed', () => recipeFixture((root, source) => {
  const original = sharedSpiderMonkeyRecipes(root);
  const parsed: unknown = Bun.YAML.parse(source);
  const producer = object(object(object(parsed).jobs)['shared-spidermonkey-prebuild']);
  producer.name = 'Producer display name';
  producer['timeout-minutes'] = 60;
  writeFileSync(join(root, '.github/workflows/ci.yml'), Bun.YAML.stringify(parsed));
  expect(sharedSpiderMonkeyRecipes(root)).toBe(original);
  writeFileSync(join(root, '.github/workflows/ci.yml'), source.replace('id: shared-sm-artifact', 'id: removed-boundary'));
  expect(() => sharedSpiderMonkeyRecipes(root)).toThrow('transfer boundary');
}));

test('new nested local producer actions are hashed and select both blocking owners', () => recipeFixture((root, source) => {
  const path = '.github/actions/spidermonkey-future-helper/action.yml';
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), 'runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo helper\n');
  const setup = join(root, '.github/actions/setup-tools/action.yml');
  writeFileSync(setup, readFileSync(setup, 'utf8') + '    - uses: ./.github/actions/spidermonkey-future-helper\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  const original = sharedSpiderMonkeyRecipes(root);
  writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replace('echo helper', 'echo changed'));
  expect(sharedSpiderMonkeyRecipes(root)).not.toBe(original);
  expect(needsSharedNative([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
  const updated = source.replaceAll('uses: ./.github/actions/setup-tools', 'uses: ./.github/actions/missing');
  writeFileSync(join(root, '.github/workflows/ci.yml'), updated);
  expect(() => sharedSpiderMonkeyRecipes(root)).toThrow();
}));

test('extracting a producer tool helper keeps subsequent helper changes in the identity', () => recipeFixture(root => {
  const helper = 'scripts/ci-spidermonkey-future-helper.ts';
  writeFileSync(join(root, helper), 'export const flags = "-O2";\n');
  writeFileSync(join(root, 'scripts/ci-build-tools.ts'), 'import { flags } from "./ci-spidermonkey-future-helper";\nexport { flags };\n');
  const original = sharedSpiderMonkeyRecipes(root);
  writeFileSync(join(root, helper), 'export const flags = "-O0";\n');
  expect(sharedSpiderMonkeyRecipes(root)).not.toBe(original);
  expect(needsSharedNative([helper])).toBe(true);
  expect(needsRust([helper])).toBe(true);
}));

test.each(recipeBindings.filter(path => path.startsWith('scripts/ci-')))('%s selects both shared producer owners', path => {
  expect(needsSharedNative([path])).toBe(true);
  expect(needsRust([path])).toBe(true);
});

test('the maintained native-input command changes identity for tool, SDK and sysroot bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-wasm-sm-tools-'));
  try {
    const tools = join(root, 'tools'), cargo = join(root, 'cargo'), sysroot = join(root, 'sysroot');
    for (const path of ['bin', 'tools/wasi-sdk/bin', 'cargo/bin', 'sysroot/lib/wasm32-wasip1', 'host']) mkdirSync(join(root, path), { recursive: true });
    const programs = ['rustc', 'cargo', 'clang', 'clang++', 'llvm-readobj', 'python3', 'autoconf2.13', 'make', 'perl', 'dpkg-query'];
    const binary = '#!/bin/sh\nprintf "fixture tool\\n"\n';
    for (const program of programs) writeFileSync(join(root, 'bin', program), binary, { mode: 0o755 });
    for (const path of ['tools/wasi-sdk/bin/clang++', 'cargo/bin/cbindgen', 'host/clang', 'host/clang++']) writeFileSync(join(root, path), binary, { mode: 0o755 });
    for (const path of ['bun-wasm-sysroot.json', 'lib/wasm32-wasip1/libc.a']) writeFileSync(join(sysroot, path), 'fixture sysroot');
    const input = command('shared-spidermonkey-prebuild', 'Identify shared SpiderMonkey native inputs').replaceAll('/usr/bin/clang', join(root, 'host/clang'));
    const output = join(root, 'output');
    const identity = () => {
      writeFileSync(output, '');
      execFileSync('bash', ['-euo', 'pipefail', '-c', input], { env: { ...process.env, WASM_TOOLS: tools, WASI_SDK_PATH: join(tools, 'wasi-sdk'),
        CARGO_HOME: cargo, BUN_WASM_SYSROOT: sysroot, PATH: join(root, 'bin') + ':' + process.env.PATH,
        RUNNER_TEMP: root, GITHUB_ENV: join(root, 'environment'), GITHUB_OUTPUT: output } });
      const result = readFileSync(output, 'utf8').match(/^hash=([a-f0-9]{64})$/m)?.[1];
      assert(result);
      return result;
    };
    const original = identity();
    const paths = programs.filter(program => program !== 'clang++').map(program => join(root, 'bin', program)).concat(
      ['tools/wasi-sdk/bin/clang++', 'cargo/bin/cbindgen', 'host/clang', 'host/clang++', 'sysroot/bun-wasm-sysroot.json', 'sysroot/lib/wasm32-wasip1/libc.a'].map(path => join(root, path)));
    for (const path of paths) {
      const before = readFileSync(path);
      writeFileSync(path, before.toString().replace('fixture', 'changed'));
      expect(identity()).not.toBe(original);
      writeFileSync(path, before);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('the maintained transfer verifier rejects stale sysroot receipts and corrupt libc', () => fixture(({ received, sysroot, digest }) => {
  const receipt = join(sysroot, 'bun-wasm-sysroot.json');
  const before = readFileSync(receipt, 'utf8');
  writeFileSync(receipt, before.replace('a'.repeat(64), 'c'.repeat(64)));
  expect(() => verifyPrebuild(received, sysroot, digest)).toThrow('sharedSysroot changed');
  writeFileSync(receipt, before);
  writeFileSync(join(sysroot, 'lib/wasm32-wasip1/libc.a'), 'corrupt');
  expect(() => verifyPrebuild(received, sysroot, digest)).toThrow('libc bytes do not match');
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
