// Side imports the common core cannot satisfy: env and GOT symbols that are neither core exports
// (scripts/quickjs-core-exports.txt) nor definitions the side exports itself. Prints one
// `module.name` per line and exits 1 when any remain.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const linkerProvided = new Set(["__memory_base", "__table_base", "memory", "__indirect_function_table"]);

export function importDelta(side: WebAssembly.Module, coreExports: ReadonlySet<string>): string[] {
  const sideExports = new Set(WebAssembly.Module.exports(side).map(entry => entry.name));
  return WebAssembly.Module.imports(side)
    .filter(entry => entry.module === "env" || entry.module === "GOT.mem" || entry.module === "GOT.func")
    .filter(entry => !(entry.module === "env" && linkerProvided.has(entry.name)))
    .filter(entry => !coreExports.has(entry.name) && (entry.module === "GOT.mem" || !sideExports.has(entry.name)))
    .map(entry => `${entry.module}.${entry.name}`)
    .sort();
}

if (import.meta.main) {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error("usage: side-import-delta.ts SIDE.wasm");
  const list = readFileSync(join(import.meta.dir, "quickjs-core-exports.txt"), "utf8");
  const coreExports = new Set(list.split(/\s+/).filter(Boolean));
  const delta = importDelta(new WebAssembly.Module(readFileSync(path)), coreExports);
  for (const name of delta) console.log(name);
  if (delta.length) {
    console.error(`${path}: ${delta.length} imports the core does not export`);
    process.exit(1);
  }
}
