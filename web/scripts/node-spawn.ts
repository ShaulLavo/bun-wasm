import type { ChildTransport, ChildWorker, SpawnMeta } from "../src/subprocess.ts";
import { executableNotFound } from "../src/spawn-error.ts";

/** The headless host registers these guest runtime names, not arbitrary native commands. */
const executables = new Set(["bun", "/bun", "/usr/local/bin/bun", "node", "/node", "/usr/local/bin/node"]);

export function launchNodeExecutable(meta: SpawnMeta, _transport: ChildTransport, launch: () => ChildWorker): ChildWorker {
  const executable = meta.executable ?? meta.argv[0]!;
  if (executables.has(executable)) return launch();
  throw executableNotFound(executable);
}
