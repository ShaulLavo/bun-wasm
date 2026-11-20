import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const runs: Record<string, number> = {};
Reflect.set(globalThis, "limitRuns", runs);

function atLimit(path: string) {
  let attempted = false;
  function recurse() {
    try { recurse(); } catch (error) { if (!(error instanceof RangeError)) throw error; }
    if (attempted) return;
    attempted = true;
    try { require(path); } catch (error) { if (!(error instanceof RangeError)) throw error; }
  }
  recurse();
}

for (const shape of ["plain", "chain", "sibling", "cycle", "combined"]) {
  const name = (part: string) => `${shape}-${part}`;
  const load = (part: string) => `import './${name(part)}.mjs';`;
  const write = (part: string, body: string) => {
    const key = JSON.stringify(name(part));
    writeFileSync(`${name(part)}.mjs`, `globalThis.limitRuns[${key}] = (globalThis.limitRuns[${key}] || 0) + 1; ${body}`);
  };
  write("ok", "export const marker = {};");
  write("leaf", "export const value = 3;");
  write("deep", `${load("leaf")} export const value = 3;`);
  write("a", `${load("b")} export const a = 4;`);
  write("b", `${load("a")} export const b = 5;`);
  let imports = "";
  if (shape === "sibling" || shape === "combined") imports += load("ok");
  if (shape === "chain" || shape === "sibling" || shape === "combined") imports += load("deep");
  if (shape === "cycle" || shape === "combined") imports += load("a");
  write("root", `${imports} export const value = 42;`);
  const path = `./${name("root")}.mjs`;
  atLimit(path);
  const root = require(path);
  const relevant = Object.keys(runs).filter(key => key.startsWith(`${shape}-`));
  console.log(shape, root.value, "once", relevant.every(key => runs[key] === 1), "same", root === require(path));
}
writeFileSync("control.cjs", "module.exports = 6;");
console.log("commonjs", require("./control.cjs"));
function recurse(): number { return 1 + recurse(); }
try { recurse(); } catch (error) {
  if (!(error instanceof RangeError)) throw error;
  console.log("second recursion", "RangeError");
}
