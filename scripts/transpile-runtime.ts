import { readFileSync, writeFileSync } from "node:fs";
const [source, destination, ...options] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node scripts/transpile-runtime.ts <source.ts> <output.js> [--minify-whitespace]");

const input = readFileSync(source, "utf8");
if (!options.includes("--minify-whitespace")) {
  const { stripTypeScriptTypes } = await import("node:module");
  // Erasure replaces types with spaces so every token keeps its line and column. A line that held
  // only types becomes all spaces; empty it so the embedded runtime does not carry that padding.
  // Template text is never erased, so such a line cannot be inside a template literal.
  const text = input;
  const lines = text.split("\n");
  const emitted = stripTypeScriptTypes(text, { mode: "strip" }).split("\n");
  if (emitted.length !== lines.length) throw new Error(`${source}: type erasure changed the line count`);
  const blank = (line: string, index: number) => /^[ \t]+$/.test(line) && /\S/.test(lines[index] ?? "");
  writeFileSync(destination, emitted.map((line, index) => blank(line, index) ? "" : line).join("\n"));
} else {
  if (typeof Bun === "undefined") throw new Error("--minify-whitespace requires Bun");
  const prefix = "globalThis.factory=";
  const output = new Bun.Transpiler({ loader: "ts", minifyWhitespace: true })
    .transformSync(`globalThis.factory = ${input}`);
  if (!output.startsWith(prefix) || !output.endsWith(";")) throw new Error("Unexpected compact runtime output");
  writeFileSync(destination, `(${output.slice(prefix.length, -1)})\n`);
}
