import { spawn } from 'node:child_process';
import { openSync, closeSync, readSync, writeSync, readFileSync } from 'node:fs';
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
const scratch = process.env.WASM_TABLE_SCRATCH;
assert.ok(scratch);
const input = openSync(join(scratch, 'input'), 'r+');
const output = openSync(join(scratch, 'output'), 'r+');
const child = spawn(join(scratch, 'target/debug/wasm-table-source-unit'), [], { stdio: [input, output, 'inherit'] });
const received = Buffer.alloc(65536);
let pending = '';
function call(name: string, args: unknown[]) {
  writeSync(input, JSON.stringify({ name: 'wasm.' + name, args: encode(args) }) + '\n');
  while (!pending.includes('\n')) pending += received.toString('utf8', 0, readSync(output, received));
  const end = pending.indexOf('\n');
  const response = JSON.parse(pending.slice(0, end));
  pending = pending.slice(end + 1);
  if (response.error) {
    const ctor = response.error.kind === 'TypeError' ? TypeError : response.error.kind === 'RangeError' ? RangeError : Error;
    throw new ctor(response.error.message);
  }
  return decode(response.ok);
}
const factorySource = readFileSync(join(process.cwd(), 'crates/bunwasm-runtime/src/js/webassembly.js'), 'utf8');
const factory = runInThisContext(stripTypeScriptTypes(factorySource));
const native = new Proxy({}, { get: (_, name) => (...args: unknown[]) => call(String(name), args) });
const api = factory({ native: { wasm: native } });
function fixture(name: string) { return new api.Module(readFileSync(join(scratch, name + '.wasm'))); }
function check(condition: unknown, message: string) { assert.ok(condition, message); }
try {
  const contract = readFileSync(join(process.cwd(), 'tests/wasm-tables/contract.ts'), 'utf8');
  runInNewContext(stripTypeScriptTypes(contract), { WebAssembly: api, fixture, check, gc: globalThis.gc, console, WeakRef, FinalizationRegistry });
  if (process.env.WASM_TABLE_SWC) {
    const path = process.env.WASM_TABLE_SWC;
    const module = { exports: {} };
    const source = readFileSync(join(path, 'wasm.js'), 'utf8');
    runInNewContext(source, { module, exports: module.exports, require: createRequire(join(path, 'wasm.js')), __dirname: path,
      WebAssembly: api, TextDecoder, TextEncoder, Buffer, console }, { filename: 'exact-cached-swc/wasm.js' });
    const backend: unknown = module.exports;
    assert.ok(backend && typeof backend === 'object' && 'transformSync' in backend && typeof backend.transformSync === 'function');
    const result = backend.transformSync('export const answer: number = 42;', { jsc: { parser: { syntax: 'typescript' } } });
    assert.match(result.code, /export const answer = 42/);
    console.log('PASS exact cached SWC transform', result.code.trim());
  }
} finally {
  child.kill();
  closeSync(input);
  closeSync(output);
  await new Promise(resolve => child.once('exit', resolve));
}
