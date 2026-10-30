import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// The browser host's shared lane (web/src/shared-objects/lane.ts) is also the wasm engines'
// runtime module `shared_lane`, used by group_shared_objects for MessagePort lanes.
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node scripts/generate-shared-lane.ts <lane.ts> <output.js>");
const stripped = stripTypeScriptTypes(readFileSync(source, "utf8"));
for (const name of ["createSharedLaneBuffer", "openSharedLane"]) {
  if (!new RegExp(`^export function ${name}\\(`, "m").test(stripped)) throw new Error(`Shared lane source has no exported ${name}`);
}
if (/^\s*(import|export)\b(?! function )/m.test(stripped.replace(/^export function /gm, "function "))) throw new Error("Shared lane source has a module import or export the runtime cannot load");
writeFileSync(destination, `(function () {\n"use strict";\n${stripped.replace(/^export function /gm, "function ")}\nreturn { createSharedLaneBuffer, openSharedLane };\n})\n`);
