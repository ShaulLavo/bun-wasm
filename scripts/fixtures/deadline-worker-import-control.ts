import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";

if (process.argv[2] === "worker") {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== "playwright") return nextResolve(specifier, context);
      const scratch = process.argv[3];
      if (!scratch) throw new Error("missing worker fixture directory");
      writeFileSync(join(scratch, "worker-browser-import.pid"), String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw new Error("worker browser import barrier unexpectedly resumed");
    },
  });
}
