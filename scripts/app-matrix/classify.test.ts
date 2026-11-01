import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compareEngines, failure, firstError, stageOutput } from "./classify.ts";
import type { ComparisonRow } from "./classify.ts";

const diagnostics = [
  ["\u001b[31mTypeError: red\u001b[0m", "TypeError: red"],
  ["6:37:22 AM [vite] (ssr) Error when evaluating SSR module /index.js: disconnected", "Error when evaluating SSR module /index.js: disconnected"],
  ["unhandledRejection [SyntaxError: Unexpected token '.']", "SyntaxError: Unexpected token '.'"],
  ["uncaughtException TypeError: stopped", "TypeError: stopped"],
  ["[TypeError: opendir is not a function]", "TypeError: opendir is not a function"],
  ["1 | throw new Error('code frame')\nwarning: ignored\nReferenceError: module is not defined", "ReferenceError: module is not defined"],
  ["EACCES: permission denied", "EACCES: permission denied"],
  ["circular import: binding 'Fragment' is not resolvable", "circular import: binding 'Fragment' is not resolvable"],
  ["Export named 'Http2ServerResponse' not found in module 'node:http2'.", "Export named 'Http2ServerResponse' not found in module 'node:http2'."],
  ["The requested module 'node:http2' does not provide an export named 'Http2ServerResponse'", "The requested module 'node:http2' does not provide an export named 'Http2ServerResponse'"],
  ["memory allocation of 16777216 bytes failed", "memory allocation of 16777216 bytes failed"],
  ["thread 'main' panicked at cli.rs:1", "thread 'main' panicked at cli.rs:1"],
  ["index.ts(1,2): error TS2322: wrong type", "index.ts(1,2): error TS2322: wrong type"],
  ["warning: nothing useful", "No diagnostic before exit or deadline"],
] satisfies readonly (readonly [string, string])[];
for (const [output, expected] of diagnostics) {
  test(`first diagnostic: ${expected}`, () => expect(firstError(output)).toBe(expected));
}

test("first diagnostic extracts ESLint JSON from mixed terminal output", () => {
  const result = '[{"filePath":"/home/user/index.ts","messages":[{"ruleId":null,"nodeType":null,"fatal":true,"severity":2,"message":"Parsing error: Unexpected token :","line":1,"column":21}],"suppressedMessages":[],"errorCount":1,"fatalErrorCount":1,"warningCount":0,"fixableErrorCount":0,"fixableWarningCount":0,"source":"export const message: number = 1;\\n","usedDeprecatedRules":[]}]';
  const output = `$ bun install\n117 packages installed [14929ms]\n$ bun run node_modules/eslint/bin/eslint.js --format json --no-cache index.ts\n${result}\n[1] $`;
  expect(firstError(output)).toBe("Parsing error: Unexpected token :");
  expect(failure(output, "lint")).toEqual({ category: "d", blocker: "lint: Parsing error: Unexpected token :" });
});

test("first diagnostic rejects unrelated JSON objects and incomplete lint messages", () => {
  const outputs = [
    '{"filePath":"/home/user/index.ts","messages":[{"severity":2,"message":"Error: not an array"}]}',
    '[{"filePath":"/home/user/index.ts","messages":[{"message":"Error: missing severity"}]}]',
    '[{"filePath":"/home/user/index.ts","messages":[{"severity":2,"message":7}]}]',
    '["Error: unrelated JSON array"]',
  ];
  for (const output of outputs) expect(firstError(output)).toBe("No diagnostic before exit or deadline");
});

test("runtime exit fallback uses the last complete exit but never overrides a diagnostic", () => {
  const first = '[bun-wasm:exit] {"reason":"process.exit","code":7,"stack":null,"loop":null}';
  const last = '[bun-wasm:exit] {"reason":"event-loop-drained","code":0,"stack":null,"loop":null}';
  const output = `${first}\n${last}\n[bun-wasm:exit] {`;
  expect(firstError(output)).toBe("Runtime exited 0: event-loop-drained");
  expect(firstError(`Error: real diagnostic\n${output}`)).toBe("Error: real diagnostic");
  expect(firstError(`Error: ${"x".repeat(600)}`)).toBe(`Error: ${"x".repeat(493)}`);
});

const categories = [
  ["error: Your current platform linux/wasm32 is unsupported", "a"],
  ["Error: Native Prisma engine is unavailable", "a"],
  ["Error: native addon requires dlopen", "a"],
  ["Error: Cannot load addon.node", "a"],
  ["Error: unsupported architecture", "a"],
  ["Error: node:child_process is unavailable", "b"],
  ["Error: external executable missing", "b"],
  ["Error: IPC is not implemented", "b"],
  ["Error: spawn is not supported", "b"],
  ["Error: tryEnableSourceMapsForHost is missing", "c"],
  ["Error: legacy-cli.mjs is unavailable", "c"],
  ["Error: No such module: fs", "c"],
  ["ReferenceError: module is not defined", "d"],
  ["No diagnostic before exit or deadline", "d"],
] satisfies readonly (readonly [string, ReturnType<typeof failure>["category"]])[];
for (const [output, category] of categories) {
  test(`failure category ${category}: ${output}`, () => {
    expect(failure(output, "build")).toEqual({ category, blocker: category === "d" ? `build: ${output}` : output });
  });
}

test("stage output uses the last exact command and preserves body whitespace until the next prompt", () => {
  const command = "bun run dev";
  const log = `$ ${command}\nError: old\n$ bun install\nignored\n\u001b[32m$ ${command}\u001b[0m\n  Error: current  \n\n[1] $ \n[1] $ bun run next\nError: later`;
  expect(stageOutput(log, command)).toBe("  Error: current  \n");
  expect(stageOutput(`$ ${command}\nraw\r\nlast\n`, command)).toBe("raw\r\nlast\n");
  expect(stageOutput(`$ ${command}`, command)).toBe("");
  expect(() => stageOutput(log, "bun run missing")).toThrow("Missing stage boundary for bun run missing");
});

test("Next build errors appended to type-checking progress retain the failed stage diagnostic", () => {
  const command = "bun run .matrix-command.ts node_modules/next/dist/bin/next build";
  const log = [
    "$ bun install",
    "debug: EAGAIN during install write backpressure",
    `$ ${command}`,
    " ✓ Compiled successfully in 48s",
    "   Linting and checking validity of types  ..EAGAIN: resource temporarily unavailable, open '/home/user/node_modules/typescript/lib/typescript.js'",
    "Next.js build worker exited with code: 1 and signal: null",
    "[1] $",
  ].join("\n");
  expect(failure(stageOutput(log, command), "build")).toEqual({
    category: "d",
    blocker: "build: EAGAIN: resource temporarily unavailable, open '/home/user/node_modules/typescript/lib/typescript.js'",
  });
});

test("embedded debug and backpressure EAGAIN text is not a diagnostic", () => {
  const outputs = [
    "debug: EAGAIN: resource temporarily unavailable, open '/tmp/cache'",
    "install write backpressure: EAGAIN: resource temporarily unavailable",
    "Linting and checking validity of types  ..",
    "✓ Compiled successfully in 48s",
  ];
  for (const output of outputs) expect(firstError(output)).toBe("No diagnostic before exit or deadline");
});

test("Svelte Rollup early exit retains its raw build diagnostic", () => {
  const log = readFileSync(new URL("./review-evidence/svelte-quickjs-build.log", import.meta.url), "utf8")
    .replaceAll("user@bun:~$", "$");
  const output = stageOutput(log, "bun run .matrix-command.ts node_modules/vite/bin/vite.js build");
  expect(output).toContain("(vite-plugin-sveltekit-compile) writeBundle");
  expect(failure(output, "build")).toEqual({
    category: "d",
    blocker: "build: Unexpected early exit. This happens when Promises returned by plugins cannot resolve. Unfinished hook action(s) on exit:",
  });
});

test("only matching QuickJS failures get category f, retaining extra fields and pass order", () => {
  const failed: Readonly<ComparisonRow & { blocker: string; metadata: { code: number } }> = Object.freeze({
    app: "prettier", host: "native", stage: "check", engine: "quickjs", status: "fail", category: "c",
    blocker: "Error: missing", metadata: { code: 7 }, passesOn: Object.freeze(["jsc"] satisfies ComparisonRow["engine"][]),
  });
  const pass: Readonly<ComparisonRow> = Object.freeze({ app: "prettier", host: "native", stage: "check", engine: "browser", status: "pass" });
  const jsc: Readonly<ComparisonRow> = Object.freeze({ ...pass, engine: "jsc" });
  const unmatched = [
    { ...pass, app: "other" }, { ...pass, host: "playground" }, { ...pass, stage: "build" },
    { ...pass, engine: "quickjs" }, { ...pass, engine: "reference" }, { ...jsc, status: "fail" }, { ...jsc, status: "blocked" },
  ] satisfies ComparisonRow[];
  const initial: ComparisonRow[] = [failed];
  expect(compareEngines(Object.freeze(initial.concat(unmatched)))[0]).toBe(failed);
  const rows = Object.freeze(initial.concat(unmatched, [pass, jsc, pass]));
  const result = compareEngines(rows);
  expect(result).not.toBe(rows);
  expect(result[0]).toEqual({ ...failed, category: "f", passesOn: ["browser", "jsc", "browser"] });
  expect(result[0]).not.toBe(failed);
  expect(result[0]).toHaveProperty("metadata", failed.metadata);
  expect(failed.category).toBe("c");
  expect(failed.passesOn).toEqual(["jsc"]);
  for (let index = 1; index < rows.length; index++) expect(result[index]).toBe(rows[index]);
  expect(compareEngines(Object.freeze([]))).toEqual([]);
});

test("all retained review logs still produce a diagnostic without changing their source", () => {
  for (const path of ["next-quickjs-dev.log", "prisma-quickjs-install.log", "vite-react-quickjs-playground.log"]) {
    expect(firstError(readFileSync(new URL(`./review-evidence/${path}`, import.meta.url), "utf8"))).not.toBe("No diagnostic before exit or deadline");
  }
});

test("classifier callers and runner source hashes resolve the renamed source", () => {
  for (const path of ["browser.mjs", "checks.mjs", "reclassify.mjs", "review.test.mjs", "run.mjs", "exit-provenance.test.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(source).toContain('from "./classify.ts"');
    expect(source).not.toContain('from "./classify.mjs"');
  }
  const runner = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
  const inventory = runner.match(/runnerSources = Object\.fromEntries\(([^\n]+)\.map\(path =>/)?.[1];
  expect(inventory).toContain('"classify.ts"');
  expect(inventory).not.toContain('"classify.mjs"');
  for (const match of inventory?.matchAll(/"([^"]+)"/g) ?? []) {
    expect(readFileSync(new URL(match[1] ?? "", import.meta.url)).length).toBeGreaterThan(0);
  }
});

test("plain stage anchors reject multiline providers and command suffixes inside output", () => {
  expect(() => stageOutput("repo on main\n❯ bun run dev\nbody\nrepo on main\n❯ ", "bun run dev")).toThrow("Missing stage boundary");
  expect(() => stageOutput("$ printed $ bun run dev\nbody", "bun run dev")).toThrow("Missing stage boundary");
  expect(stageOutput("[130] $ bun run dev\nbody\n[1] $ ", "bun run dev")).toBe("body");
});

for (const body of ["$ body output", "[1] $ body output"]) {
  test(`stage output keeps dollar-prefixed application output: ${body}`, () => {
    expect(stageOutput(`$ bun run dev\n${body}\nmore output\n[1] $ `, "bun run dev")).toBe(`${body}\nmore output`);
  });
}
