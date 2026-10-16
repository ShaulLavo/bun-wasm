import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node scripts/transpile-runtime.ts <source.ts> <output.js>");

writeFileSync(destination, stripTypeScriptTypes(readFileSync(source, "utf8"), { mode: "strip" }));
