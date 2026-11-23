import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Two modes. The default (Node.js 24+) erases TypeScript types and keeps every token's line and column.
// `--minify-whitespace` (Bun) erases types the same way, then removes whitespace and comments only:
// identifiers, function names and syntax stay, so `Function.prototype.name` and error messages still
// show the real names. Line and column positions do not survive minifying, and `toString()` returns
// the reprinted text.
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

const isLineEnd = (char: string) => char === "\n" || char === "\r" || char.charCodeAt(0) === 0x2028 || char.charCodeAt(0) === 0x2029;
const noticeWords = /copyright|licen[sc]e|permission/i;
const notice = (comment: string) => comment.startsWith("/*!") || noticeWords.test(comment);

/**
 * Skips whitespace, comments and semicolons from `from`. Returns where it stopped and the comments on
 * the way that carry a copyright, license or permission notice. Used before the factory and after it,
 * where nothing else can appear.
 */
function skipFiller(text: string, from: number): { end: number; notices: string } {
  const lineEnds = String.fromCharCode(0x0a, 0x0d, 0x2028, 0x2029);
  const filler = new RegExp(`\\s+|;|//[^${lineEnds}]*|/\\*[\\s\\S]*?\\*/`, "y");
  let end = from, notices = "";
  filler.lastIndex = from;
  for (let match = filler.exec(text); match; match = (filler.lastIndex = end, filler.exec(text))) {
    if (match[0].startsWith("/") && notice(match[0])) notices += `${match[0]}\n`;
    end += match[0].length;
  }
  return { end, notices };
}

const regexAfterWord = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const regexAfterPunctuation = "(,=:[!&|?{};+-*%<>~^";
// A line break before one of these does not end a statement. `!`, `~`, `++` and `--` cannot continue an
// expression, so a string followed by them on the next line is a whole statement.
const continuesStatement = "([.+-*/%<>=&|^?,:`";

/**
 * Finds the string statements of `text` that can be directives, as [start, end) ranges, and where its
 * last token ends. It tracks strings, templates, comments and regular expressions, so a quote or `/*` in
 * one of them is never read as code. A string is a directive candidate when it is a whole statement:
 * it follows `{`, `;` or `}` and is followed by `;`, `}`, the end, or a line break that does not
 * continue the expression. `x = "use strict"` is not. A parenthesized string statement is refused: Bun
 * would print it as a bare string and could turn it into a directive.
 * This is a lexer for the runtime's own modules, not a full parser; `tests` compare its result with
 * a real parser for every module.
 */
function scanDirectives(text: string, from: number): { ranges: [number, number][]; codeEnd: number } {
  const ranges: [number, number][] = [];
  let pos = from, codeEnd = from, previous = "", before = "";
  const set = (token: string) => {
    before = previous;
    previous = token;
  };
  const boundary = (token: string) => token === "{" || token === ";" || token === "}";
  const trivia = (): boolean => {
    let newline = false;
    for (;;) {
      const char = text[pos];
      if (char === undefined) return newline;
      if (isLineEnd(char)) { newline = true; pos++; continue; }
      if (/\s/.test(char)) { pos++; continue; }
      if (char === "/" && text[pos + 1] === "/") {
        while (pos < text.length && !isLineEnd(text[pos]!)) pos++;
        continue;
      }
      if (char !== "/" || text[pos + 1] !== "*") return newline;
      const close = text.indexOf("*/", pos + 2), stop = close < 0 ? text.length : close + 2;
      for (let index = pos; index < stop; index++) if (isLineEnd(text[index]!)) newline = true;
      pos = stop;
    }
  };
  const string = (quote: string) => {
    pos++;
    while (pos < text.length) {
      const char = text[pos++];
      if (char === "\\") pos++;
      else if (char === quote) return;
    }
  };
  const regex = () => {
    let inClass = false;
    pos++;
    while (pos < text.length) {
      const char = text[pos++]!;
      if (char === "\\") pos++;
      else if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) break;
      else if (isLineEnd(char)) return;
    }
    while (pos < text.length && /[\w$]/.test(text[pos]!)) pos++;
  };
  const template = () => {
    pos++;
    while (pos < text.length) {
      const char = text[pos]!;
      if (char === "\\") pos += 2;
      else if (char === "`") { pos++; return; }
      else if (char === "$" && text[pos + 1] === "{") { pos += 2; code(true); }
      else pos++;
    }
  };
  // A string token; records it when it is a whole statement, which makes it a directive candidate.
  const stringToken = (quote: string, start: number) => {
    const statement = boundary(previous);
    const parenthesized = previous === "(" && (before === "" || boundary(before));
    string(quote);
    const end = pos;
    const newline = trivia(), next = text[pos];
    pos = end;
    if (parenthesized && next === ")") throw new Error(`Parenthesized string statement at offset ${start} is not supported`);
    // After a line break `++` and `--` start the next statement instead of continuing this one.
    const prefixOperator = (next === "+" || next === "-") && text[pos + 1] === next;
    const terminated = statement && (next === undefined || next === ";" || next === "}" || (newline && (prefixOperator || !continuesStatement.includes(next))));
    if (terminated) ranges.push([start, end]);
    // A string that is a whole statement ends it, so the next string can be a statement too.
    set(terminated ? ";" : "string");
  };
  const code = (inTemplate: boolean) => {
    let braces = 0;
    for (;;) {
      trivia();
      const char = text[pos];
      if (char === undefined) return;
      const start = pos;
      if (char === '"' || char === "'") {
        stringToken(char, start);
        codeEnd = pos;
      } else if (char === "`") {
        template();
        set("template");
        codeEnd = pos;
      } else if (char === "/") {
        const keyword = regexAfterWord.has(previous) && before !== ".";
        if (previous === "" || keyword || (previous.length === 1 && regexAfterPunctuation.includes(previous))) {
          regex();
          set("regex");
        } else {
          pos++;
          set("/");
        }
        codeEnd = pos;
      } else if (/[\w$]/.test(char) || char.charCodeAt(0) > 0x7f) {
        while (pos < text.length && (/[\w$]/.test(text[pos]!) || text.charCodeAt(pos) > 0x7f)) pos++;
        set(text.slice(start, pos));
        codeEnd = pos;
      } else {
        pos++;
        if (char === "}" && inTemplate && braces === 0) return;
        if (char === "{") braces++;
        if (char === "}") braces--;
        // `++` and `--` end an operand (`n++ / 2`), so a `/` after them is a division.
        if ((char === "+" || char === "-") && text[pos] === char) {
          pos++;
          set(char + char);
        } else set(char);
        if (char !== ";") codeEnd = pos;
      }
    }
  };
  code(false);
  return { ranges, codeEnd };
}

// Bun treats its input as an ES module and drops every "use strict" directive, but the runtime evaluates
// these files as classic scripts, where the directive decides the semantics. Each directive candidate is
// swapped for a marker string that Bun keeps as an ordinary directive, and swapped back afterwards.
const directive = "use strict";

function minify(input: string): string {
  if (!transpiler) throw new Error("Missing runtime transpiler");
  const leading = skipFiller(input, 0);
  if (input[leading.end] !== "(") throw new Error("Runtime module must start with its factory expression");
  const { ranges, codeEnd } = scanDirectives(input, leading.end);
  const trailing = skipFiller(input, codeEnd);
  if (trailing.end !== input.length) {
    throw new Error(`Runtime module has code after its factory expression, at offset ${trailing.end}: ${JSON.stringify(input.slice(trailing.end - 40, trailing.end + 40))}`);
  }
  // A random token that no source can spell, even with escapes, marks the swapped directives.
  const marker = `${directive} ${crypto.randomUUID()}`;
  let factory = input.slice(leading.end, codeEnd), offset = leading.end;
  for (const [start, end] of ranges.toReversed()) {
    const text = input.slice(start, end);
    if (text.slice(1, -1) === directive) factory = `${factory.slice(0, start - offset)}"${marker}"${factory.slice(end - offset)}`;
  }
  // A bare factory expression is dead code to the transpiler, so it is assigned and read back.
  const prefix = "globalThis.factory=";
  const output = transpiler.transformSync(`globalThis.factory = ${factory}`);
  if (!output.startsWith(prefix) || !output.endsWith(";")) throw new Error("Unexpected compact runtime output");
  const body = output.slice(prefix.length, -1).replaceAll(marker, directive);
  // The loader calls the result, so it must be one function or arrow expression with a block body, not
  // a call of one; it is parsed here, never run.
  if (!/^(async\b|function\b|\([^()]*\)\s*=>|[\w$]+\s*=>)/.test(body) || !body.endsWith("}")) {
    throw new Error("Runtime module must be a function expression with a block body");
  }
  new Function(`return (${body}\n)`);
  const text = `${leading.notices}(${body})\n${trailing.notices}`;
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
  if (result.error) throw new Error(`runtime-js phase=strip could not start Node.js: ${result.error.message}`);
  if (result.status !== 0) throw new Error("runtime-js phase=strip failed");
  return inputs;
}

function run(): void {
  const sources = paths.filter((_, index) => index % 2 === 0);
  // Beside the first output, one directory per run, so a build killed mid-way leaves a few files in its
  // own output directory and never in a shared temporary directory or in another run's way.
  const scratch = compact ? mkdtempSync(join(dirname(paths[1] ?? "."), ".runtime-strip-")) : undefined;
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
