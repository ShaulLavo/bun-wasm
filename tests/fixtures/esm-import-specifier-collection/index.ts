// JavaScriptCore turns each static import specifier into a string and then allocates a second
// string for the importing module's name. A collection started by the second allocation must keep
// the first string alive. Each child forces a collection on every Nth allocation slow path, a
// JavaScriptCore debugging option that other engines ignore, while one module resolves thousands
// of distinct specifiers. The retained strings leave every string block mostly full, so the
// allocator refills often and collections land between the two allocations.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const edges = 20000;
const retained = 400000;
const cadences = [23, 29, 31, 37];
const wide = "./wide/wide.mjs";

function generate(): void {
  mkdirSync("wide", { recursive: true });
  writeFileSync("wide/leaf.mjs", "export const value = 1;\n");
  const imports = Array.from({ length: edges }, (_, edge) => `import "./e${edge}/../leaf.mjs";`);
  writeFileSync("wide/wide.mjs", imports.concat(`export const edges = ${edges};`, "").join("\n"));
}

function fillStringBlocks(): (string | undefined)[] {
  const strings: (string | undefined)[] = new Array(retained);
  for (let index = 0; index < retained; index++) strings[index] = (index + 1e7).toString(36);
  for (let index = 0; index < retained; index += 8) strings[index] = undefined;
  return strings;
}

function loadUnder(cadence: number): string {
  const child = spawnSync(process.execPath, [import.meta.path, "load"], {
    env: { ...process.env, JSC_slowPathAllocsBetweenGCs: String(cadence) },
    encoding: "utf8",
  });
  if (child.status === 0) return child.stdout.trim();
  return `exit ${child.status}: ${child.stderr.trim().split("\n")[0]}`;
}

if (process.argv[2] === "load") {
  const strings = fillStringBlocks();
  console.log("loaded", (await import(wide)).edges, "imports with", strings.length, "strings");
} else {
  generate();
  for (const cadence of cadences) console.log(`cadence ${cadence}: ${loadUnder(cadence)}`);
}
