import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runs: Record<string, number> = {};
Reflect.set(globalThis, "cacheRuns", runs);

function moduleSource(name: string, body: string) {
  writeFileSync(`${name}.mjs`, `globalThis.cacheRuns[${JSON.stringify(name)}] = (globalThis.cacheRuns[${JSON.stringify(name)}] || 0) + 1; ${body}`);
}

function caught(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("require unexpectedly succeeded");
}

async function imported(name: string): Promise<unknown> {
  try { await import(`./${name}.mjs`); } catch (error) { return error; }
  throw new Error("import unexpectedly succeeded");
}

async function cached(name: string, body: string, importFirst = false) {
  moduleSource(name, body);
  const first = importFirst ? await imported(name) : caught(() => require(`./${name}.mjs`));
  const second = importFirst ? await imported(name) : caught(() => require(`./${name}.mjs`));
  const third = importFirst ? caught(() => require(`./${name}.mjs`)) : await imported(name);
  console.log(name, "runs", runs[name], "same", first === second && second === third);
  return first;
}

await cached("ordinary", "throw new Error('ordinary');");
await cached("import-first", "throw new Error('import first');", true);
await cached("user-range", "throw new RangeError('too much recursion');");
await cached("overflow", "function recurse() { return 1 + recurse(); } recurse();");
await cached("overflow-import", "function recurse() { return 1 + recurse(); } recurse();", true);
let saved: unknown;
function recurse(): number { return 1 + recurse(); }
try { recurse(); } catch (error) { saved = error; }
Reflect.set(globalThis, "savedOverflow", saved);
const rethrown = await cached("rethrow", "throw globalThis.savedOverflow;");
console.log("saved identity", rethrown === saved);

moduleSource("cyc-a", "import './cyc-b.mjs'; throw new Error('cycle');");
moduleSource("cyc-b", "import './cyc-a.mjs'; export const value = 2;");
const cycle = caught(() => require("./cyc-a.mjs"));
console.log("cycle runs", runs["cyc-a"], runs["cyc-b"], "same",
  cycle === caught(() => require("./cyc-a.mjs")) && cycle === await imported("cyc-b"));

moduleSource("dep-fail", "throw new Error('dependency');");
moduleSource("parent", "import './dep-fail.mjs'; export const value = 1;");
const dependency = await imported("dep-fail");
const parent = caught(() => require("./parent.mjs"));
moduleSource("parent", "export const value = 99;");
console.log("inherited", parent === dependency && parent === caught(() => require("./parent.mjs")),
  "parent runs", runs.parent || 0);

moduleSource("tla", "await new Promise(r => setTimeout(r, 10)); throw new Error('later');");
console.log("pending", caught(() => require("./tla.mjs")) instanceof TypeError);
await new Promise(resolve => setTimeout(resolve, 25));
const later = await imported("tla");
console.log("pending cached", later === await imported("tla"), "runs", runs.tla);

moduleSource("slow", "await new Promise(r => setTimeout(r, 10)); throw new Error('slow');");
moduleSource("uses-slow", "import './slow.mjs'; export const value = 3;");
const slow = imported("slow");
console.log("import pending", caught(() => require("./uses-slow.mjs")) instanceof TypeError);
const slowError = await slow;
console.log("import pending cached", slowError === await imported("uses-slow"), "runs", runs.slow,
  "parent runs", runs["uses-slow"] || 0);
