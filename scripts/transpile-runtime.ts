import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const compact = args.includes("--minify-whitespace");
const paths = args.filter(arg => arg !== "--minify-whitespace");
const batch = paths[0] === "--batch";
if (batch) paths.shift();
if (paths.length === 0 || paths.length % 2 !== 0 || (!batch && paths.length !== 2)) {
  throw new Error("Usage: transpile-runtime.ts [--batch] <source.ts> <output.js> ... [--minify-whitespace]");
}
const { stripTypeScriptTypes } = compact ? { stripTypeScriptTypes: undefined } : await import("node:module");
if (compact && typeof Bun === "undefined") throw new Error("--minify-whitespace requires Bun");
const transpiler = compact ? new Bun.Transpiler({ loader: "ts", minifyWhitespace: true }) : undefined;

function transform(source: string, destination: string): void {
  const input = readFileSync(source, "utf8");
  if (stripTypeScriptTypes) {
    // Erasure replaces types with spaces so every token keeps its line and column. A line that held
    // only types becomes all spaces; empty it so the embedded runtime does not carry that padding.
    // Template text is never erased, so such a line cannot be inside a template literal.
    const text = input;
    const lines = text.split("\n");
    const emitted = stripTypeScriptTypes(text, { mode: "strip" }).split("\n");
    if (emitted.length !== lines.length) throw new Error(`${source}: type erasure changed the line count`);
    const blank = (line: string, index: number) => /^[ \t]+$/.test(line) && /\S/.test(lines[index] ?? "");
    writeFileSync(destination, emitted.map((line, index) => blank(line, index) ? "" : line).join("\n"));
    return;
  }
  if (!transpiler) throw new Error("Missing runtime transpiler");
  const prefix = "globalThis.factory=";
  const output = transpiler.transformSync(`globalThis.factory = ${input}`);
  if (!output.startsWith(prefix) || !output.endsWith(";")) throw new Error("Unexpected compact runtime output");
  const factory = output.slice(prefix.length, -1);
  const openingBrace = factory.indexOf("{");
  const inputOpeningBrace = input.indexOf("{");
  if (openingBrace < 0 || inputOpeningBrace < 0) throw new Error("Unexpected compact runtime factory");
  const strictDirective = (body: string) => body.match(/^(["'])use strict\1;/)?.[0];
  const directive = strictDirective(input.slice(inputOpeningBrace + 1).trimStart());
  const body = factory.slice(openingBrace + 1).trimStart();
  const emitted = directive && !strictDirective(body)
    ? `${factory.slice(0, openingBrace + 1)}${directive}${factory.slice(openingBrace + 1)}`
    : factory;
  writeFileSync(destination, `(${emitted})\n`);
}

for (let index = 0; index < paths.length; index += 2) {
  const source = paths[index], destination = paths[index + 1];
  if (!source || !destination) throw new Error("Missing runtime source or destination");
  if (batch) console.error(`runtime-js phase=${compact ? "compact" : "strip"} source=${source}`);
  try {
    transform(source, destination);
  } catch (error) {
    throw new Error(`runtime-js phase=${compact ? "compact" : "strip"} source=${source}`, { cause: error });
  }
}
