import { readFileSync, writeFileSync } from "node:fs";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node scripts/generate-bun-wrap.ts <runtime.js> <output.js>");
const runtime = readFileSync(source, "utf8");
const names = Array.from(runtime.matchAll(/^export var ([$\w]+)\s*=/gm), match => match[1]);
if (!names.includes("__decorateElement")) throw new Error("Bun runtime has no decorator helper");
writeFileSync(destination, `(function () {\n${runtime.replace(/^export var /gm, "var ")}\nreturn { ${names.join(", ")} };\n})\n`);
