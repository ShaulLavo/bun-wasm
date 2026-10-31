import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registry } from '../../scripts/app-matrix/registry.mjs';

const root = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync('/work/tmp/bun-wasm-esbuild-test-');
const children = new Set();
let mirror;
const checks = (process.env.ESBUILD_CHECKS ?? 'check.cjs,sync.cjs,watch.cjs').split(',');
const failures = [];
async function cleanup() {
  const exits = Array.from(children, child => new Promise(resolve => child.once('close', resolve)));
  for (const child of children) process.kill(-child.pid, 'SIGKILL');
  await Promise.allSettled(exits);
  await mirror?.close();
  rmSync(scratch, { recursive: true, force: true });
}
process.once('exit', () => {
  for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  rmSync(scratch, { recursive: true, force: true });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void cleanup().then(() => process.exit(130)));
async function run(engine, args) {
  const wasm = join(root, 'dist', engine === 'quickjs' ? 'bun.wasm' : `bun-${engine}.wasm`);
  const options = ['--wasm', wasm, '--dir', `${scratch}::/`, '--env', 'PWD=/', '--env', 'HOME=/', '--env', 'BUN_INSTALL_CACHE_DIR=/cache', '--env', `NPM_CONFIG_REGISTRY=${mirror.base}`, '--'].concat(args);
  const command = engine === 'browser' ? ['node', '--no-warnings', join(root, 'web/scripts/node-host.mjs'), '--net'].concat(options) : [process.env.BUN_WASM_LAUNCHER ?? '/work/tmp/bun-wasm-target/release/bun-wasm'].concat(options);
  const child = spawn(command[0], command.slice(1), { cwd: scratch, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 120000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => { clearTimeout(timer); children.delete(child); });
  assert.equal(code, 0, `${engine} ${args.join(' ')}\n${output}`);
  return output;
}
try {
  mirror = await registry({ directory: process.env.MATRIX_CACHE ?? '/work/cache/bun-wasm-app-matrix', record: false });
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ dependencies: { esbuild: '0.25.12' } }));
  for (const check of checks) copyFileSync(join(import.meta.dirname, check), join(scratch, check));
  for (const engine of (process.env.ENGINES ?? 'quickjs,jsc,browser').split(',')) {
    const failuresBefore = failures.length;
    rmSync(join(scratch, 'node_modules'), { recursive: true, force: true });
    rmSync(join(scratch, 'bun.lock'), { force: true });
    await run(engine, ['install']);
    const manifest = JSON.parse(readFileSync(join(scratch, 'node_modules/esbuild/package.json'), 'utf8'));
    assert.equal(manifest.name, 'esbuild-wasm');
    assert.equal(manifest.version, '0.25.12');
    for (const check of checks) {
const checkEsbuildFixture = async () => {
      try { console.log(engine, check, await run(engine, ['run', `/${check}`])); }
      catch (error) { failures.push(error); console.error(error.message); }

};
await checkEsbuildFixture();
}
    if (!checks.includes('check.cjs')) continue;
    assert.match(await run(engine, ['run', '/node_modules/esbuild/bin/esbuild', '--version']), /0\.25\.12/);
    await run(engine, ['run', '/node_modules/esbuild/bin/esbuild', '/entry.ts', '--bundle', '--outfile=/cli.js']);
    assert.match(readFileSync(join(scratch, 'cli.js'), 'utf8'), /43/);
    const lock = readFileSync(join(scratch, 'bun.lock'), 'utf8');
    rmSync(join(scratch, 'node_modules'), { recursive: true, force: true });
    await run(engine, ['install', '--frozen-lockfile']);
    assert.equal(readFileSync(join(scratch, 'bun.lock'), 'utf8'), lock);
    assert.equal(JSON.parse(readFileSync(join(scratch, 'node_modules/esbuild/package.json'), 'utf8')).name, 'esbuild-wasm');
    if (failures.length === failuresBefore) console.log(`PASS ${engine} official esbuild API, sync, watch, CLI, frozen reinstall`);
  }
  assert.equal(failures.length, 0, failures.map(error => error.message).join('\n'));
  assert.deepEqual(mirror.misses, []);
  assert.deepEqual(mirror.errors, []);
} finally { await cleanup(); }
