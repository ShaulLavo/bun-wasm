import { WASI } from "node:wasi";
import { strict as assert } from "node:assert";
import { checkMemoryGrowth, checkMemoryRebinding } from "./control.ts";

checkMemoryGrowth(WASI, new WebAssembly.Memory({ initial: 1, maximum: 4 }), false);
console.log("PASS WASI unshared memory growth");
checkMemoryRebinding(WASI);
console.log("PASS WASI memory rebinding");

function sharedMemory() {
  try { return new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true }); }
  catch (error) {
    if (error instanceof WebAssembly.LinkError && error.message === "Shared WebAssembly memories are not supported") return;
    throw error;
  }
}
const shared = sharedMemory();
if (shared) {
  checkMemoryGrowth(WASI, shared, true);
  console.error("PASS WASI shared memory growth");
} else {
  assert.notEqual(process.env.BUNWASM_TEST_HOST, "node", "Browser must execute shared growth");
  console.error("SKIP WASI shared memory growth: unsupported in this guest profile");
}
console.log("PASS WASI shared memory capability control");
