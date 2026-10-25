import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [directory, mode] = process.argv.slice(2);
if (!directory || !mode) throw new Error("Missing lifecycle fixture arguments");
writeFileSync(join(directory, `${mode}.pid`), String(process.pid));
if (mode === "descendant") {
  process.stdout.write("ready\n");
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [import.meta.filename, directory, "descendant"], { stdio: ["ignore", "pipe", "inherit"] });
  child.stdout.once("data", () => {
    // The parent control waits for this line before cancellation; no startup sleep is needed.
    process.stderr.write(`runtime-js phase=fixture source=${import.meta.filename}\n`);
    if (mode === "failure") process.exit(7);
    if (mode === "success") process.exit(0);
  });
  setInterval(() => {}, 1000);
}
