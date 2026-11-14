import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
writeFileSync("once.mjs", "export const value = 1;");
writeFileSync("fresh.mjs", "export const value = 2;");
writeFileSync("ok.mjs", "globalThis.okRuns = (globalThis.okRuns || 0) + 1; globalThis.okMarker = {}; export const marker = globalThis.okMarker;");
writeFileSync("leaf.mjs", "export const value = 3;");
writeFileSync("deep.mjs", "export { value } from './leaf.mjs';");
writeFileSync("cyc-a.mjs", "import './cyc-b.mjs'; export const a = 4;");
writeFileSync("cyc-b.mjs", "import './cyc-a.mjs'; export const b = 5;");
writeFileSync("root.mjs", "export { marker } from './ok.mjs'; export { value } from './deep.mjs'; export { a } from './cyc-a.mjs'; export { b } from './cyc-b.mjs';");
writeFileSync("control.cjs", "module.exports = 6;");

let attempted = false;
function onceAtLimit() {
  try { onceAtLimit(); } catch {
    if (attempted) return;
    attempted = true;
    try { require("./once.mjs"); } catch (error) { if (!(error instanceof RangeError)) throw error; }
  }
}
onceAtLimit();
console.log("fresh", require("./fresh.mjs").value);

let recovered = false;
let rootAttempted = false;
function unwind() {
  try { unwind(); } catch (error) { if (!(error instanceof RangeError)) throw error; }
  if (rootAttempted) return;
  rootAttempted = true;
  try { require("./root.mjs"); recovered = true; } catch (error) { if (!(error instanceof RangeError)) throw error; }
}
unwind();
const root = require("./root.mjs");
console.log("root", root.value, "ok runs", Reflect.get(globalThis, "okRuns"));
console.log("marker", root.marker === require("./ok.mjs").marker && root.marker === Reflect.get(globalThis, "okMarker"));
console.log("cycle", root.a, root.b);

writeFileSync("cached-leaf.mjs", "globalThis.cachedRuns = (globalThis.cachedRuns || 0) + 1; export const value = 7;");
writeFileSync("cached-root.mjs", "import './cached-leaf.mjs'; export const value = 8;");
recovered = false;
function everyLevel() {
  try { everyLevel(); } catch (error) { if (!(error instanceof RangeError)) throw error; }
  if (recovered) return;
  try { require("./cached-root.mjs"); recovered = true; } catch (error) { if (!(error instanceof RangeError)) throw error; }
}
everyLevel();
let cached: unknown;
try { require("./cached-root.mjs"); } catch (error) { cached = error; }
let repeated: unknown;
try { require("./cached-root.mjs"); } catch (error) { repeated = error; }
console.log("unwind cached", cached instanceof RangeError, cached === repeated, "body runs", Reflect.get(globalThis, "cachedRuns") || 0);
console.log("commonjs", require("./control.cjs"));
function recurse(): number { return 1 + recurse(); }
try { recurse(); } catch (error) {
  if (!(error instanceof RangeError)) throw error;
  console.log("second recursion", "RangeError");
}
