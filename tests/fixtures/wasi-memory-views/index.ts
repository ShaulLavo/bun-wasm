import { WASI } from "node:wasi";
import { checkMemoryGrowth, checkMemoryRebinding } from "./control.ts";

checkMemoryGrowth(WASI, new WebAssembly.Memory({ initial: 1, maximum: 4 }), false);
checkMemoryRebinding(WASI);

function sharedMemory() {
  try { return new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true }); }
  catch (error) {
    if (error instanceof WebAssembly.LinkError && error.message === "Shared WebAssembly memories are not supported") return;
    throw error;
  }
}
const shared = sharedMemory();
if (shared) checkMemoryGrowth(WASI, shared, true);
else console.log("SKIP WASI shared memory growth: unsupported in this guest profile");
