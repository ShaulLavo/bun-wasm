import { spawnSync } from "node:child_process";

if (process.argv[2] !== "control") {
  const child = spawnSync(process.execPath, [import.meta.filename, "control"], {
    env: { ...process.env, BUN_WASM_STACK_KIB: "32" }, encoding: "utf8",
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  if (child.status !== 0) throw new Error(`native call child exited ${child.status}`);
} else {
  for (const mode of ["call", "apply"]) {
    let depth = 0;
    function visit(): number {
      if (++depth === 55) return depth;
      return mode === "call" ? visit.call(undefined) : visit.apply(undefined, []);
    }
    if (visit() !== 55) throw new Error(`${mode} changed its result`);
    console.log(mode, "55 completed");
  }
  let caught = false;
  function overflow(): number { return 1 + overflow.apply(undefined, []); }
  try { overflow(); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    caught = true;
  }
  if (!caught) throw new Error("native reentry did not throw RangeError");
  console.log("native overflow caught");
  console.log("continued");
}
