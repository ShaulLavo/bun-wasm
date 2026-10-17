import { childTransport, type ChildTransport, type ChildWorker, type SpawnMeta } from "../src/subprocess.ts";

/** The headless host registers these guest runtime names, not arbitrary native commands. */
const executables = new Set(["bun", "/bun", "/usr/local/bin/bun", "node", "/node", "/usr/local/bin/node"]);

export function launchNodeExecutable(meta: SpawnMeta, transport: ChildTransport, launch: () => ChildWorker): ChildWorker {
  const executable = meta.executable ?? meta.argv[0]!;
  if (executables.has(executable)) return Object.assign(launch(), { starting: true as const });
  childTransport(transport).startFailed("ENOENT");
  return { terminate() {} };
}
