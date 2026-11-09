import { spawnSync } from "node:child_process";

const child = spawnSync(process.execPath, [`${import.meta.dir}/control.ts`], {
  env: { ...process.env, BUN_WASM_STACK_KIB: "32" }, encoding: "utf8",
});
process.stdout.write(child.stdout);
process.stderr.write(child.stderr);
if (child.status !== 0) throw new Error(`native call child exited ${child.status}`);
