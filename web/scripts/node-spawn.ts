import { childTransport, type ChildTransport, type ChildWorker, type SpawnMeta } from "../src/subprocess.ts";

/** The headless host registers these guest runtime names, not arbitrary native commands. */
const executables = new Set(["bun", "/bun", "/usr/local/bin/bun", "node", "/node", "/usr/local/bin/node"]);

export function launchNodeExecutable(meta: SpawnMeta, transport: ChildTransport, launch: () => ChildWorker): ChildWorker {
  const executable = meta.executable ?? meta.argv[0]!;
  if (executables.has(executable)) return launch();
  const child = childTransport(transport);
  child.stderr.write(new TextEncoder().encode(`bun-wasm: executable not found: ${executable}\n`));
  // Publish a wait result, not a synchronous spawn error. A microtask cannot run while the
  // synchronous guest is polling spawnSync, so a known-missing entry completes here.
  child.finish(127);
  return { terminate() {} };
}
