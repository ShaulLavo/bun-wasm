// A post over a group lane commits in one native call, and the guarantee that a `postMessage`
// which throws has moved nothing rests on that call being the last thing the function does: no
// statement after it, no `try` around it, no result taken from it. This checks that shape in the
// JavaScript the guest actually embeds, which the build makes from the TypeScript sources with
// `scripts/transpile-runtime.ts`, and in every wrapper that forwards to a port's `postMessage`.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "worker-post-shape-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The module as the build emits it: the same script, in the mode the build uses for it. */
function emitted(stem: string): string {
  const output = join(scratch, `${stem}.js`);
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, `crates/bunwasm-runtime/src/js/${stem}.ts`), output], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return readFileSync(output, "utf8");
}

/** `source` with every comment and string body replaced by spaces, so brackets can be counted. */
function codeOnly(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => { for (let index = from; index < to; index++) if (out[index] !== "\n") out[index] = " "; };
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2), one = source[index]!;
    let end = index + 1;
    if (two === "//") end = source.indexOf("\n", index) < 0 ? source.length : source.indexOf("\n", index);
    else if (two === "/*") end = source.indexOf("*/", index) + 2;
    else if (one === '"' || one === "'" || one === "`") end = stringEnd(source, index);
    else { index++; continue; }
    blank(two === "//" || two === "/*" ? index : index + 1, two === "//" || two === "/*" ? end : end - 1);
    index = end;
  }
  return out.join("");
}
/** The index after the closing quote. A template's `${}` parts are part of the string here: none of the bodies checked has one. */
function stringEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") index++;
    else if (source[index] === source[start]) return index + 1;
  }
  throw new Error("Unterminated string");
}
/** Erasure leaves spaces where types were. One space between tokens, none before `,` or `)`, no indentation. */
function normal(code: string): string {
  return code.replace(/[ \t]+/g, " ").replace(/ ([,)])/g, "$1").replace(/\n /g, "\n");
}
/** The body of the one method or function `header` matches, from its first `{`, without its braces. */
function bodyOf(code: string, header: RegExp): string {
  const found = Array.from(code.matchAll(new RegExp(header, "g")));
  if (found.length !== 1) throw new Error(`Expected exactly one ${header}, found ${found.length}`);
  const open = found[0]!.index + found[0]![0].indexOf("{");
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === "{") depth++;
    if (code[index] === "}" && --depth === 0) return code.slice(open + 1, index);
  }
  throw new Error("Unbalanced body");
}
/** The statements at the top level of a body: split where a `;` or a block's `}` ends one. */
function statements(body: string): string[] {
  const list: string[] = [];
  let depth = 0, start = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if ("({[".includes(char)) depth++;
    if (")}]".includes(char)) depth--;
    const ends = depth === 0 && (char === ";" || char === "}");
    if (!ends) continue;
    list.push(body.slice(start, index + 1).trim());
    start = index + 1;
  }
  if (body.slice(start).trim()) list.push(body.slice(start).trim());
  return list.filter(Boolean);
}

const emittedThreads = emitted("worker_threads");
const threads = normal(codeOnly(emittedThreads));
const web = normal(codeOnly(emitted("web_worker")));
/** The port's own method, told from the wrappers of the same name by its first statement. */
const PORT_POST = /\npostMessage\(value, transfer\) \{\nif \(!arguments\.length\) throw Object\.assign/;

test("the commit call is the last statement of postMessage, bare and at the top level", () => {
  const list = statements(bodyOf(threads, PORT_POST));
  // The whole statement: not `return`, not an assignment, no spread, nothing awaited.
  expect(list.at(-1)).toBe("internal.native.transferArrayBuffers(call[0], call[1], call[2], call[3], call[4], call[5], call[6]);");
  // Top level means inside no `try`, `finally`, loop or branch: `statements` splits only there.
  expect(list.filter(statement => statement.includes("transferArrayBuffers"))).toHaveLength(1);
  expect(list.some(statement => /^(try|for|while|do|switch|using)\b/.test(statement))).toBe(false);
  // Everything fallible comes first, and the statement before the call only stages.
  expect(list.at(-2)).toBe("const call = beginPost(state, group.io, state.peer, packet, list);");
});

test("postMessage is a plain method: its return is an ordinary function return", () => {
  expect(PORT_POST.test(threads)).toBe(true);
  expect(/\basync\s+postMessage\(value, transfer\)|\*\s*postMessage\(value, transfer\)/.test(threads)).toBe(false);
});

test("every wrapper forwards to the port's postMessage as its own last statement", () => {
  const worker = threads.match(/postMessage\(value, transfer\) \{ (this\.#port\.postMessage\(value, transfer\);) \}/);
  expect(worker?.[1]).toBe("this.#port.postMessage(value, transfer);");
  for (const header of [/\npostMessage\(value, transfer\) \{\nif \(this\.#phase/, /\npostMessage\(value, transfer\) \{\nif \(!arguments\.length\) throw new TypeError/]) {
    const list = statements(bodyOf(web, header));
    expect(list.at(-1)).toMatch(/^(this\.#worker|port)\.postMessage\(value, transferList\(transfer\)\);$/);
    expect(list.some(statement => /^(try|for|while|do|switch|using)\b/.test(statement))).toBe(false);
  }
});

test("the build emits these modules by erasing types, statement for statement", () => {
  const build = readFileSync(join(root, "crates/bunwasm-runtime/build/polyfills.rs"), "utf8");
  // Only these two stems go through the minifying transpiler, which may rewrite statements.
  expect(build).toContain('let batch = if matches!(stem, "stack_trace" | "bun_builtins") {');
  expect(build).toContain("transpile_batch(&ordinary, &transpiler, false);");
  // Erasure keeps every line: the emitted module has the source's line count.
  const source = readFileSync(join(root, "crates/bunwasm-runtime/src/js/worker_threads.ts"), "utf8");
  expect(emittedThreads.split("\n").length).toBe(source.split("\n").length);
});
