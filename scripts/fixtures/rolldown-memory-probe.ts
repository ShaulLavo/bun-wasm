import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [tree, mode, adapted] = process.argv.slice(2);
assert(tree && (mode === "stock" || mode === "small"));
const filename = join(tree, "node_modules/@rolldown/binding-wasm32-wasi/rolldown-binding.wasi.cjs");
const require = createRequire(filename);
const source = readFileSync(mode === "small" && adapted ? adapted : filename, "utf8");
const descriptors: WebAssembly.MemoryDescriptor[] = [];
const memories: WebAssembly.Memory[] = [];
const phases: string[] = [];
class ObservedMemory extends WebAssembly.Memory {
  constructor(descriptor: WebAssembly.MemoryDescriptor) {
    phases.push("memory:enter");
    super(descriptor);
    phases.push("memory:return");
    descriptors.push(descriptor);
    memories.push(this);
  }
}
const scopedWasm = { ...WebAssembly, Memory: ObservedMemory };
const loaded = new Module(filename);
loaded.filename = filename;
try {
  new Function("require", "module", "exports", "__filename", "__dirname", "WebAssembly", source)(
    require, loaded, loaded.exports, filename, dirname(filename), scopedWasm,
  );
} catch (error) {
  assert(error instanceof Error);
  console.log(JSON.stringify({ mode, phases, descriptors, loadError: { name: error.name, message: error.message, stack: error.stack } }));
  process.exit(0);
}
require.cache[filename] = loaded;
const binding = loaded.exports;
phases.push("binding:return");
const startedBytes = memories.map(memory => memory.buffer.byteLength);
const input = "export const answer: number = 40 + 2;";
const parsed = binding.parseSync("entry.ts", input);
assert.equal(parsed.errors.length, 0);
const transformed = binding.transformSync("entry.ts", input);
assert.equal(transformed.errors.length, 0);
assert(!transformed.code.includes(": number"));
const minified = binding.minifySync("entry.js", "globalThis.answer = 40 + 2;");
assert.equal(minified.errors.length, 0);
const scope = {};
new Function("globalThis", minified.code)(scope);
assert("answer" in scope && scope.answer === 42);
const large = Array.from({ length: 8000 }, (_, index) => `globalThis.value${index} = ${index};`).join("\n");
assert.equal(binding.transformSync("large.js", large).errors.length, 0);
const errors = binding.parseSync("bad.ts", "const = ;").errors;
assert(errors.length > 0);
let badArgument: unknown;
try {
  binding.transformSync(null, null);
  assert.fail("Expected argument error");
} catch (error) {
  assert(error instanceof Error);
  badArgument = { name: error.name, message: error.message, code: Reflect.get(error, "code") };
  assert.equal(Reflect.get(error, "code"), "StringExpected");
}
binding.startAsyncRuntime();
const asyncParsed = await binding.parse("entry.ts", input);
assert.deepEqual(asyncParsed.program, parsed.program);
assert.deepEqual(await binding.transform("entry.ts", input), transformed);
assert.deepEqual(await binding.minify("entry.js", "globalThis.answer = 40 + 2;"), minified);
phases.push("async:return");
process.env.NAPI_RS_FORCE_WASI = "true";
const { rolldown } = await import(pathToFileURL(require.resolve("rolldown")).href);
const bundle = await rolldown({ input: "entry.js", plugins: [{
  name: "memory-control",
  resolveId: (id: string) => id === "entry.js" ? id : null,
  load: (id: string) => id === "entry.js" ? "export const answer = 40 + 2;" : null,
}] });
const generated = await bundle.generate({ format: "es" });
assert.equal(generated.output.length, 1);
const chunk = generated.output[0];
assert.equal(chunk.type, "chunk");
assert(chunk.code.includes("42"));
await bundle.close();
phases.push("bundle:return");
const grownBytes = memories.map(memory => memory.buffer.byteLength);
await binding[Symbol.for("napi.rs.wasi.dispose")]();
phases.push("dispose:return");
assert.deepEqual(descriptors, [{ initial: mode === "stock" ? 16384 : 1001, maximum: 65536, shared: true }]);
console.log(JSON.stringify({ mode, phases, descriptors, startedBytes, grownBytes,
  output: { transformed, minified, errors, bundle: chunk.code }, badArgument }));
