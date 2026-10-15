import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { registry } from '../../scripts/app-matrix/registry.mjs';

const root = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync('/work/tmp/bun-wasm-rollup-test-');
const children = new Set();
let mirror;
async function cleanup() {
  for (const child of children) child.kill('SIGKILL');
  await mirror?.close();
  rmSync(scratch, { recursive: true, force: true });
}
process.once('exit', () => { for (const child of children) child.kill('SIGKILL'); rmSync(scratch, { recursive: true, force: true }); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void cleanup().then(() => process.exit(130)));
async function run(engine, args) {
  const wasm = join(root, 'dist', engine === 'quickjs' ? 'bun.wasm' : `bun-${engine}.wasm`);
  const options = ['--wasm', wasm, '--dir', `${scratch}::/`, '--env', 'PWD=/', '--env', 'HOME=/', '--env', 'BUN_INSTALL_CACHE_DIR=/cache', '--env', `NPM_CONFIG_REGISTRY=${mirror.base}`, '--'].concat(args);
  const command = engine === 'browser' ? ['node', '--no-warnings', join(root, 'web/scripts/node-host.mjs'), '--net'].concat(options) : [process.env.BUN_WASM_LAUNCHER ?? '/work/tmp/bun-wasm-target/release/bun-wasm'].concat(options);
  const child = spawn(command[0], command.slice(1), { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => { clearTimeout(timer); children.delete(child); });
  assert.equal(code, 0, `${engine} ${args.join(' ')}\n${output}`);
  return output;
}
try {
  mirror = await registry({ directory: process.env.MATRIX_CACHE ?? '/work/cache/bun-wasm-app-matrix', record: false });
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ type: 'module', dependencies: { rollup: '4.64.7' } }));
  writeFileSync(join(scratch, 'check.js'), `
import assert from 'node:assert/strict';
import { parseAst, parseAstAsync } from 'rollup/parseAst';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { xxhashBase16, xxhashBase36, xxhashBase64Url } = require('./node_modules/rollup/dist/native.js');
const source = 'export const answer = "日本語";';
const ast = parseAst(source);
assert.equal(ast.body[0].declaration.declarations[0].init.value, '日本語');
assert.equal((await parseAstAsync(source)).body[0].type, 'ExportNamedDeclaration');
assert.throws(() => parseAst('export const ='), /Unexpected token/);
for (const hash of [xxhashBase16, xxhashBase36, xxhashBase64Url]) {
  assert.equal(typeof hash(new Uint8Array([1,2,3])), 'string');
  assert.notEqual(hash(new Uint8Array([1,2,3])), hash(new Uint8Array([4,5,6])));
}
console.log('rollup parser and hashes passed');
`);
  for (const engine of (process.env.ENGINES ?? 'quickjs,jsc,browser').split(',')) {
    rmSync(join(scratch, 'node_modules'), { recursive: true, force: true });
    rmSync(join(scratch, 'bun.lock'), { force: true });
    await run(engine, ['install']);
    const manifest = JSON.parse(readFileSync(join(scratch, 'node_modules/rollup/package.json'), 'utf8'));
    assert.equal(manifest.name, '@rollup/wasm-node');
    assert.equal(manifest.version, '4.64.7');
    const lock = readFileSync(join(scratch, 'bun.lock'), 'utf8');
    assert.match(await run(engine, ['run', '/check.js']), /rollup parser and hashes passed/);
    rmSync(join(scratch, 'node_modules'), { recursive: true, force: true });
    await run(engine, ['install', '--frozen-lockfile']);
    assert.equal(readFileSync(join(scratch, 'bun.lock'), 'utf8'), lock);
    assert.match(await run(engine, ['run', '/check.js']), /rollup parser and hashes passed/);
    console.log(`PASS ${engine} official Rollup parser, hashes, frozen reinstall`);
  }
  assert.deepEqual(mirror.misses, []);
  assert.deepEqual(mirror.errors, []);
} finally { await cleanup(); }
