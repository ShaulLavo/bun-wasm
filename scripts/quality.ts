import { run } from "./quality-command";

const gates = {
  javascript: ["lint", "types", "unused", "duplicates", "probes"],
  native: ["rust", "wasi"],
};

export function qualityGates(args: readonly string[]): string[] {
  if (args.length === 0) return gates.javascript.concat(gates.native);
  if (args.length !== 1) throw new Error("Usage: quality [--javascript | --native]");
  if (args[0] === "--javascript") return gates.javascript;
  if (args[0] === "--native") return gates.native;
  throw new Error("Usage: quality [--javascript | --native]");
}

if (import.meta.main) {
  for (const gate of qualityGates(process.argv.slice(2))) run(["bun", "run", `quality:${gate}`]);
}
