// A stack read after a file is reloaded maps through the new file's positions. Adding
// type-only lines keeps the generated positions and moves the original ones, so a frame
// formatted for the first load must not be reused.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const path = resolve("reloaded.ts");
const thrower = "export function thrower(count: number): number {\n  if (count > 0) throw new Error(\"reloaded\");\n  return count;\n}\n";
function reloadedFrame() {
  delete require.cache[path];
  let stack = "";
  try { require(path).thrower(1); } catch (error) { stack = String(error.stack); }
  return stack.split("\n").find(text => text.includes("reloaded.ts"))?.replace(/^.*reloaded\.ts:/, "reloaded.ts:");
}
writeFileSync(path, thrower);
console.log("first load:", reloadedFrame());
console.log("same file again:", reloadedFrame());
writeFileSync(path, "interface A { a: number }\ninterface B { b: string }\n" + thrower);
console.log("after reload:", reloadedFrame());
