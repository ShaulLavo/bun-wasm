import { run } from "./quality-command";

for (const gate of ["lint", "types", "unused", "duplicates", "probes", "rust", "wasi"]) {
  run(["bun", "run", `quality:${gate}`]);
}
