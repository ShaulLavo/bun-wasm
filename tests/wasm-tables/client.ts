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
  const request = Buffer.from(JSON.stringify({ name: name.startsWith('bridge.') ? name : 'wasm.' + name, args: encode(args) }) + '\n');
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
// Stand-in for the engine across the process boundary: a mirror of each memory's span,
// pushed before every native operation that runs wasm and pulled while its generation holds.
type Mirror = { buffer: WeakRef<ArrayBuffer>; generation: unknown };
const mirrors = new Map<number, Mirror>();
const handed = new WeakSet<ArrayBuffer>();
const runsWasm = new Set(['call', 'resume', 'instantiate', 'growMemory']);
function push() {
  for (const [id, mirror] of mirrors) {
    const buffer = mirror.buffer.deref();
    if (buffer === undefined) { mirrors.delete(id); continue; }
    if (buffer.byteLength) call('bridge.write', [id, new Uint8Array(buffer)]);
  }
}
function pull(id: number, generation: unknown) {
  const mirror = mirrors.get(id);
  const buffer = mirror?.buffer.deref();
  if (!buffer || mirror?.generation !== generation || !buffer.byteLength) return;
  new Uint8Array(buffer).set(call('bridge.read', [id]) as Uint8Array);
}
const native = new Proxy({}, { get: (_, name) => (...args: unknown[]) => {
  if (runsWasm.has(String(name))) push();
  const result = call(String(name), args);
  if (name === 'memorySpan') pull(args[0] as number, (result as { generation: unknown }).generation);
  return result;
} });
function wasmMemoryBuffer(id: number, previous: ArrayBuffer | undefined) {
  if (previous !== undefined) {
    assert.ok(handed.has(previous), 'previous buffer came from wasmMemoryBuffer');
    if (previous.byteLength) previous.transfer(0);
  }
  const span = call('memorySpan', [id]) as { length: number; generation: unknown };
  const buffer = new ArrayBuffer(span.length);
  if (span.length) new Uint8Array(buffer).set(call('bridge.read', [id]) as Uint8Array);
  handed.add(buffer);
  mirrors.set(id, { buffer: new WeakRef(buffer), generation: span.generation });
  return buffer;
}
const api = factory({ native: { wasm: native, wasmMemoryBuffer } });
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
    const localApi = localFactory({ native: { wasm: native, wasmMemoryBuffer } });
    const root = { teardown: true };
    const table = new localApi.Table({ element: 'externref', initial: 1 });
    table.set(0, root);
    assert.equal(table.get(0), root);
    const memory = new localApi.Memory({ initial: 1 });
    return { root: new WeakRef(root), buffer: new WeakRef(memory.buffer) };
  })();
  for (let i = 0; i < 12; i++) await collect();
  assert.equal(weak.root.deref(), undefined, 'runtime-local root map released with factory realm');
  assert.equal(weak.buffer.deref(), undefined, 'memory buffer/state released with factory realm');
  console.log('PASS actual JS realm teardown releases externref roots');
}

try {
  const contract = readFileSync(join(process.cwd(), 'tests/wasm-tables/contract.ts'), 'utf8');
  const oracleFixture = (name: string) => new WebAssembly.Module(readFileSync(join(scratch, name + '.wasm')));
  await runInNewContext(stripTypeScriptTypes(contract), { WebAssembly, fixture: oracleFixture, check, gc: globalThis.gc, console, WeakRef, FinalizationRegistry, setImmediate });
  console.log('PASS host oracle contract');
  const corrections = readFileSync(join(process.cwd(), 'tests/wasm-tables/corrections.ts'), 'utf8');
  await runInNewContext(stripTypeScriptTypes(corrections), { WebAssembly, fixture: oracleFixture, check, sourceMemory: false, gc: globalThis.gc, console, WeakRef, setImmediate });
  await runInNewContext(stripTypeScriptTypes(corrections), { WebAssembly: api, fixture, check, sourceMemory: true, gc: globalThis.gc, console, WeakRef, setImmediate });
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
