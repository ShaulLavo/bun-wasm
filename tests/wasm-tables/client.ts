import { spawn } from 'node:child_process';
import { openSync, closeSync, readSync, writeSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes, createRequire } from 'node:module';
import { runInThisContext, runInNewContext } from 'node:vm';
import { join } from 'node:path';
import assert from 'node:assert/strict';

type Wire = [string, unknown?];
function encode(value: unknown): Wire {
  if (value === undefined) return ['undefined'];
  if (value === null) return ['null'];
  if (typeof value === 'boolean') return ['bool', value];
  if (typeof value === 'number') return ['number', Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value)];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (typeof value === 'string') return ['string', value];
  if (value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')];
  if (Array.isArray(value)) return ['array', value.map(encode)];
  assert.equal(typeof value, 'object');
  return ['object', Object.entries(value).map(([key, item]) => [key, encode(item)])];
}
function decode(input: unknown): unknown {
  assert.ok(Array.isArray(input));
  const [tag, value] = input;
  if (tag === 'undefined') return undefined;
  if (tag === 'null') return null;
  if (tag === 'number') return Number(value);
  if (tag === 'bigint') return BigInt(value);
  if (tag === 'bytes') return new Uint8Array(Buffer.from(value, 'base64'));
  if (tag === 'array') return value.map(decode);
  if (tag === 'object') return Object.fromEntries(value.map(([key, item]: [string, unknown]) => [key, decode(item)]));
  return value;
}
const scratchValue = process.env.WASM_TABLE_SCRATCH;
assert.ok(scratchValue);
const scratch: string = scratchValue;
const input = openSync(join(scratch, 'input'), 'r+');
const output = openSync(join(scratch, 'output'), 'r+');
const child = spawn(join(scratch, 'target/debug/wasm-table-source-unit'), [], { stdio: [input, output, 'inherit'] });
assert.ok(child.pid);
writeFileSync(join(scratch, 'native.pid'), String(child.pid));
function stop() { child.kill(); }
process.once('SIGTERM', () => { stop(); process.exit(143); });
process.once('SIGINT', () => { stop(); process.exit(130); });
const received = Buffer.alloc(65536);
let pending = Buffer.alloc(0);
function responseLine() {
  const chunks: Buffer[] = [];
  while (true) {
    const chunk = pending.length ? pending : received.subarray(0, readSync(output, received));
    const end = chunk.indexOf(10);
    if (end !== -1) {
      chunks.push(Buffer.from(chunk.subarray(0, end)));
      pending = Buffer.from(chunk.subarray(end + 1));
      return Buffer.concat(chunks).toString('utf8');
    }
    chunks.push(Buffer.from(chunk));
    pending = Buffer.alloc(0);
  }
}
function call(name: string, args: unknown[]) {
  const request = Buffer.from(JSON.stringify({ name: 'wasm.' + name, args: encode(args) }) + '\n');
  let offset = 0;
  while (offset < request.length) offset += writeSync(input, request, offset, request.length - offset);
  const response = JSON.parse(responseLine());
  if (response.error) {
    const ctor = response.error.kind === 'TypeError' ? TypeError : response.error.kind === 'RangeError' ? RangeError : Error;
    throw new ctor(response.error.message);
  }
  return decode(response.ok);
}
const factorySource = readFileSync(join(process.cwd(), 'crates/bunwasm-runtime/src/js/webassembly.ts'), 'utf8');
const factory = runInThisContext(stripTypeScriptTypes(factorySource));
const native = new Proxy({}, { get: (_, name) => (...args: unknown[]) => call(String(name), args) });
const api = factory({ native: { wasm: native } });
function fixture(name: string) { return new api.Module(readFileSync(join(scratch, name + '.wasm'))); }
function check(condition: unknown, message: string) { assert.ok(condition, message); }
async function collect() {
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(globalThis.gc);
  globalThis.gc();
}
async function teardownRoots() {
  const weak = (() => {
    const localFactory = runInNewContext(stripTypeScriptTypes(factorySource));
    const localApi = localFactory({ native: { wasm: native } });
    const root = { teardown: true };
    const table = new localApi.Table({ element: 'externref', initial: 1 });
    table.set(0, root);
    assert.equal(table.get(0), root);
    return new WeakRef(root);
  })();
  for (let i = 0; i < 12; i++) await collect();
  assert.equal(weak.deref(), undefined, 'runtime-local root map released with factory realm');
  console.log('PASS actual JS realm teardown releases externref roots');
}

try {
  const contract = readFileSync(join(process.cwd(), 'tests/wasm-tables/contract.ts'), 'utf8');
  const oracleFixture = (name: string) => new WebAssembly.Module(readFileSync(join(scratch, name + '.wasm')));
  await runInNewContext(stripTypeScriptTypes(contract), { WebAssembly, fixture: oracleFixture, check, gc: globalThis.gc, console, WeakRef, FinalizationRegistry, setImmediate });
  console.log('PASS host oracle contract');
  const lifetime = readFileSync(join(process.cwd(), 'tests/wasm-tables/lifetime.ts'), 'utf8');
  await runInNewContext(stripTypeScriptTypes(contract + lifetime), { WebAssembly: api, fixture, check, gc: globalThis.gc, console, WeakRef, FinalizationRegistry, setImmediate });
  await teardownRoots();
  if (process.env.WASM_TABLE_SWC) {
    const path = process.env.WASM_TABLE_SWC;
    const module = { exports: {} };
    const source = readFileSync(join(path, 'wasm.js'), 'utf8');
    runInNewContext(source, { module, exports: module.exports, require: createRequire(join(path, 'wasm.js')), __dirname: path,
      WebAssembly: api, TextDecoder, TextEncoder, Buffer, console }, { filename: 'exact-cached-swc/wasm.js' });
    const backend: unknown = module.exports;
    assert.ok(backend && typeof backend === 'object' && 'transformSync' in backend && typeof backend.transformSync === 'function');
    const result: unknown = backend.transformSync('export const answer: number = 42;', { filename: 'probe.ts', jsc: { target: 'es2022', parser: { syntax: 'typescript' } }, module: { type: 'es6' } });
    assert.ok(result && typeof result === 'object' && 'code' in result && typeof result.code === 'string');
    assert.match(result.code, /export const answer = 42/);
    console.log('PASS exact cached SWC transform', result.code.trim());
  }
} finally {
  const exit = child.exitCode === null && child.signalCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
  child.kill();
  closeSync(input);
  closeSync(output);
  await exit;
}
