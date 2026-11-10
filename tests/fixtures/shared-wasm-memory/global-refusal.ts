// The Browser host still refuses a nested module that exports a global, before start runs. A
// table export alone is admitted: table-controls.ts covers it.
import { strict as assert } from 'node:assert';

const tableGlobal = await Bun.file(`${import.meta.dir}/table-global.wasm`).arrayBuffer();
assert.throws(() => new WebAssembly.Module(tableGlobal), (error: Error) => {
  assert.ok(error instanceof WebAssembly.CompileError);
  assert.match(error.message, /Nested globals are not available on the Browser host/);
  return true;
});
console.log('shared-wasm-memory Browser global refusal: pass');
