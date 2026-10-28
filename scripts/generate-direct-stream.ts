import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

// The browser host's direct source (web/src/native-direct-stream.ts) is also the
// portable engines' runtime module `direct_stream`, used by the streams polyfill.
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node scripts/generate-direct-stream.ts <native-direct-stream.ts> <output.js>");
const stripped = stripTypeScriptTypes(readFileSync(source, "utf8"));
if (!/^function directSource\(/m.test(stripped)) throw new Error("Direct stream source has no directSource function");
writeFileSync(destination, `(function () {\n"use strict";\n${stripped.replace(/^export function /gm, "function ")}\nreturn { directSource };\n})\n`);
