import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node scripts/transpile-runtime.ts <source.ts> <output.js>");

// Erasure replaces types with spaces so every token keeps its line and column. A line that held
// only types becomes all spaces; empty it so the embedded runtime does not carry that padding.
// Template text is never erased, so such a line cannot be inside a template literal.
const text = readFileSync(source, "utf8");
const lines = text.split("\n");
const emitted = stripTypeScriptTypes(text, { mode: "strip" }).split("\n");
if (emitted.length !== lines.length) throw new Error(`${source}: type erasure changed the line count`);
const blank = (line: string, index: number) => /^[ \t]+$/.test(line) && /\S/.test(lines[index] ?? "");
writeFileSync(destination, emitted.map((line, index) => blank(line, index) ? "" : line).join("\n"));
