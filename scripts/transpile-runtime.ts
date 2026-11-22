import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Two modes. The default (Node.js 24+) erases TypeScript types and keeps every token's line and column.
// `--minify-whitespace` (Bun) erases types the same way, then removes whitespace and comments only:
// identifiers, function names and syntax stay, so `Function.prototype.name`, error messages and
// `toString()` still show the real names. Line and column positions do not survive minifying.
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
const transpiler = compact ? new Bun.Transpiler({ loader: "js", minifyWhitespace: true }) : undefined;

// Bun treats its input as an ES module and drops every "use strict" directive, but the runtime evaluates
// these files as classic scripts, where the directive decides the semantics. The directive text is
// swapped for a placeholder that Bun keeps as an ordinary directive and swapped back afterwards.
const directive = "use strict";
const placeholder = "use bunwasm-strict-directive";

/**
 * Where the factory expression starts: after whitespace, comments and the stray semicolons that erased
 * type declarations leave. Any other leading statement is an error. Block comments that start with
 * a bang carry licenses and are returned so they stay at the top of the output.
 */
function factoryStart(input: string): { start: number; legal: string } {
  const skip = /\s+|;|\/\/[^\n]*|\/\*[\s\S]*?\*\//y;
  let start = 0, legal = "";
  for (let match = skip.exec(input); match; match = (skip.lastIndex = start, skip.exec(input))) {
    if (match[0].startsWith("/*!")) legal += `${match[0]}\n`;
    start += match[0].length;
  }
  if (input[start] !== "(") throw new Error("Runtime module must start with its factory expression");
  return { start, legal };
}

function minify(input: string): string {
  if (input.includes(placeholder)) throw new Error("Runtime source contains the directive placeholder");
  if (!transpiler) throw new Error("Missing runtime transpiler");
  const { start, legal } = factoryStart(input);
  // A bare factory expression is dead code to the transpiler, so it is assigned and read back.
  const prefix = "globalThis.factory=";
  const output = transpiler.transformSync(`globalThis.factory = ${input.slice(start).replaceAll(directive, placeholder)}`);
  if (!output.startsWith(prefix) || !output.endsWith(";")) throw new Error("Unexpected compact runtime output");
  const factory = output.slice(prefix.length, -1).replaceAll(placeholder, directive);
  // The factory must stay a single expression; anything after it would not parse inside the parentheses.
  new Function(`return (${factory}\n)`);
  const text = `${legal}(${factory})\n`;
  // Already-compact vendored bundles can grow when reprinted.
  return text.length < input.length ? text : input;
}

function strip(source: string, destination: string): void {
  if (!stripTypeScriptTypes) throw new Error("Missing runtime type stripper");
  const input = readFileSync(source, "utf8");
  // Erasure replaces types with spaces so every token keeps its line and column. A line that held
  // only types becomes all spaces; empty it so the embedded runtime does not carry that padding.
  // Template text is never erased, so such a line cannot be inside a template literal.
  const lines = input.split("\n");
  const emitted = stripTypeScriptTypes(input, { mode: "strip" }).split("\n");
  if (emitted.length !== lines.length) throw new Error(`${source}: type erasure changed the line count`);
  const blank = (line: string, index: number) => /^[ \t]+$/.test(line) && /\S/.test(lines[index] ?? "");
  writeFileSync(destination, emitted.map((line, index) => blank(line, index) ? "" : line).join("\n"));
}

/** Erases the types of every `.ts` source with one Node.js process; returns the plain JavaScript paths. */
function eraseTypes(sources: string[], scratch: string): string[] {
  const typed: string[] = [];
  const inputs = sources.map((source, index) => {
    if (!source.endsWith(".ts")) return source;
    const destination = join(scratch, `${index}.js`);
    typed.push(source, destination);
    return destination;
  });
  if (typed.length === 0) return inputs;
  const result = spawnSync("node", [import.meta.path, "--batch"].concat(typed), { stdio: ["ignore", "inherit", "inherit"] });
  if (result.status !== 0) throw new Error("runtime-js phase=strip failed");
  return inputs;
}

function run(): void {
  const sources = paths.filter((_, index) => index % 2 === 0);
  const scratch = compact ? mkdtempSync(join(tmpdir(), "bun-wasm-runtime-strip-")) : undefined;
  try {
    const inputs = scratch ? eraseTypes(sources, scratch) : sources;
    sources.forEach((source, index) => {
      const destination = paths[index * 2 + 1], input = inputs[index];
      if (!source || !destination || !input) throw new Error("Missing runtime source or destination");
      if (batch) console.error(`runtime-js phase=${compact ? "compact" : "strip"} source=${source}`);
      try {
        if (compact) writeFileSync(destination, minify(readFileSync(input, "utf8")));
        else strip(source, destination);
      } catch (error) {
        throw new Error(`runtime-js phase=${compact ? "compact" : "strip"} source=${source}`, { cause: error });
      }
    });
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

run();
