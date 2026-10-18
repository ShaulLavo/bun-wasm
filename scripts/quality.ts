import { run } from "./quality-command";

for (const gate of ["lint", "types", "unused", "duplicates", "probes", "rust"]) {
  run(["bun", "run", `quality:${gate}`]);
}
