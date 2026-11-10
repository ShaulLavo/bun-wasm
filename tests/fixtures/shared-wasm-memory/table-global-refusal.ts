// The Browser host refuses a nested module that exports a table or global, before start runs.
import { strict as assert } from 'node:assert';

const tableGlobal = await Bun.file(`${import.meta.dir}/table-global.wasm`).arrayBuffer();
assert.throws(() => new WebAssembly.Module(tableGlobal), (error: Error) => {
  assert.ok(error instanceof WebAssembly.CompileError);
  assert.match(error.message, /Nested tables and globals are not available on the Browser host/);
  return true;
});
console.log('shared-wasm-memory Browser table and global refusal: pass');
