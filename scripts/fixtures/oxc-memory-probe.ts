import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [tree, mode, name, adapted] = process.argv.slice(2);
assert(tree && name && (mode === 'stock' || mode === 'small'));
const initial = name === 'parser' ? 980 : 981;
const filename = join(tree, 'node_modules', `@oxc-${name}/binding-wasm32-wasi`, `${name}.wasi.cjs`);
const original = readFileSync(filename, 'utf8');
const source = mode === 'small' && adapted ? readFileSync(adapted, 'utf8') : original;
assert(mode === 'stock' || source !== original);
const memories: WebAssembly.Memory[] = [];
const descriptors: WebAssembly.MemoryDescriptor[] = [];
class ObservedMemory extends WebAssembly.Memory {
  constructor(descriptor: WebAssembly.MemoryDescriptor) {
    super(descriptor);
    descriptors.push(descriptor);
    memories.push(this);
  }
}
const scopedWasm = { ...WebAssembly, Memory: ObservedMemory };
const module = { exports: {} };
const require = createRequire(filename);
try {
  new Function('require', 'module', 'exports', '__filename', '__dirname', 'WebAssembly', source)(require, module, module.exports, filename, join(filename, '..'), scopedWasm);
} catch (error) {
  assert(error instanceof Error);
  console.log(JSON.stringify({ loadError: { name: error.name, message: error.message } }));
  process.exit(0);
}
const binding = module.exports;
const startedBytes = memories.map(memory => memory.buffer.byteLength);
let output: unknown;
let asyncResult: unknown;
const large = Array.from({ length: 8000 }, (_, index) => `globalThis.value${index} = ${index};`).join('\n');
if (name === 'parser') {
  assert('parseSync' in binding && typeof binding.parseSync === 'function');
  assert('parseAsync' in binding && typeof binding.parseAsync === 'function');
  const parsed = binding.parseSync('entry.ts', 'export const answer: number = 42;');
  assert.equal(parsed.errors.length, 0);
  const program = JSON.parse(parsed.program);
  assert.equal(program.node.body[0].type, 'ExportNamedDeclaration');
  assert.equal(binding.parseSync('large.js', large).errors.length, 0);
  try {
    const asynchronous = await binding.parseAsync('entry.ts', 'export const answer: number = 42;');
    assert.deepEqual(asynchronous.program, parsed.program);
    asyncResult = 'passed';
  } catch (error) {
    assert(error instanceof Error);
    asyncResult = { name: error.name, message: error.message };
  }
  const bad = binding.parseSync('bad.ts', 'const = ;');
  const errors = bad.errors;
  assert(errors.length > 0);
  output = { body: program.node.body, errors };
} else if (name === 'transform') {
  assert('transform' in binding && typeof binding.transform === 'function');
  assert('transformAsync' in binding && typeof binding.transformAsync === 'function');
  const result = binding.transform('entry.ts', 'const answer: number = 40 + 2; globalThis.answer = answer;');
  assert.equal(result.errors.length, 0);
  assert(!result.code.includes(': number'));
  const scope = {};
  new Function('globalThis', result.code)(scope);
  assert('answer' in scope && scope.answer === 42);
  assert.equal(binding.transform('large.js', large).errors.length, 0);
  try {
    const asynchronous = await binding.transformAsync('entry.ts', 'const answer: number = 40 + 2; globalThis.answer = answer;');
    assert.deepEqual(asynchronous, result);
    asyncResult = 'passed';
  } catch (error) {
    assert(error instanceof Error);
    asyncResult = { name: error.name, message: error.message };
  }
  output = result;
} else {
  assert.equal(name, 'minify');
  assert('minify' in binding && typeof binding.minify === 'function');
  const result = binding.minify('entry.js', 'function answer() { return 40 + 2; } globalThis.answer = answer();');
  assert.equal(result.errors.length, 0);
  const scope = {};
  new Function('globalThis', result.code)(scope);
  assert('answer' in scope && scope.answer === 42);
  assert.equal(binding.minify('large.js', large).errors.length, 0);
  output = result;
}
let badArgument: { name: string; message: string; code: unknown } | undefined;
try {
  const method = name === 'parser' ? 'parseSync' : name === 'transform' ? 'transform' : 'minify';
  const operation = Reflect.get(binding, method);
  operation(null, null);
  assert.fail('Expected argument error');
} catch (error) {
  assert(error instanceof Error);
  badArgument = { name: error.name, message: error.message, code: Reflect.get(error, 'code') };
}
assert.equal(badArgument?.code, 'StringExpected');
assert.equal(memories.length, 1);
const descriptor = descriptors[0];
assert(descriptor);
assert.equal(descriptor.maximum, 65536);
assert.equal(descriptor.shared, true);
assert.equal(startedBytes[0], (mode === 'stock' ? 4000 : initial) * 65536);
console.log(JSON.stringify({ engine: process.versions.bun ? 'bun' : 'node', mode, name, descriptors, startedBytes,
  grownBytes: memories.map(memory => memory.buffer.byteLength), output, badArgument, asyncResult }));
