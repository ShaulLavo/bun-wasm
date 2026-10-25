import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
import { bootstrap, preview1Executor } from "waffle/browser/worker";
import { linkedWorkerHooks } from "waffle/link";

assert(parentPort);
const port = parentPort;
const hooks = linkedWorkerHooks();
let constructors: (() => unknown) | undefined;
let finished = 0;
let sideImports: WebAssembly.Imports | undefined;

try {
  await bootstrap(workerData, {
    ...preview1Executor,
    ...hooks,
    async instantiate(imports, context) {
      const original = context.wasi.imports.bind(context.wasi);
      context.wasi.imports = (...args) => captureImports(original(...args));
      assert(hooks.instantiate);
      try {
        return await hooks.instantiate(imports, context);
      } finally {
        context.wasi.imports = original;
      }
    },
    instantiated({ instance, process }) {
      assert(process, "ordinary worker installed the real process ABI");
      const count = instance.exports.bun_core_ctor_count;
      assert.equal(typeof count, "function");
      if (typeof count !== "function") throw Error("constructor counter missing");
      assert(sideImports?.env);
      assert.equal(sideImports.env.memory, instance.exports.memory);
      assert.equal(sideImports.env.__indirect_function_table, instance.exports.__indirect_function_table);
      assert.equal(sideImports.env.__stack_pointer, instance.exports.__stack_pointer);
      const low = instance.exports.__stack_low;
      const high = instance.exports.__stack_high;
      assert(low instanceof WebAssembly.Global && high instanceof WebAssembly.Global);
      assert.equal(Number(high.value) - Number(low.value), 8 * 1024 * 1024);
      constructors = () => count();
      assert.equal(count(), 0, "constructors do not run during instantiation");
    },
    initialize(context) {
      hooks.initialize?.(context);
      hooks.initialize?.(context);
      assert.equal(constructors?.(), 1);
    },
    beforeFinish() {
      assert.equal(constructors?.(), 1, "CLI entry did not repeat constructors");
      hooks.beforeFinish?.();
      assertClearedTable();
      finished++;
    },
  }, {
    crossOriginIsolated: true,
    postMessage(message) { port.postMessage(message); },
  });
  port.postMessage({ checkpoint: "cleanup", finished });
} finally {
  workerData.filesystem.port.close();
  port.close();
}

function captureImports(imports: WebAssembly.Imports): WebAssembly.Imports {
  if (imports.env?.memory instanceof WebAssembly.Memory) sideImports = imports;
  return imports;
}

function assertClearedTable(): void {
  const env = sideImports?.env;
  assert(env?.__indirect_function_table instanceof WebAssembly.Table);
  assert(env.__table_base instanceof WebAssembly.Global);
  for (let index = Number(env.__table_base.value); index < env.__indirect_function_table.length; index++) {
    assert.equal(env.__indirect_function_table.get(index), null, "disposed side table entries");
  }
}
