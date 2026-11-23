import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript-api";

// Tests here start real processes or browsers. The limit only catches a hang.
setDefaultTimeout(120_000);

const root = resolve(import.meta.dir, "..");
const source = mkdtempSync(join(process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir()), "bun-wasm-runtime-emission-"));
afterAll(() => rmSync(source, { recursive: true, force: true }));

function emit(path: string) {
  const output = join(source, "output.js");
  const result = Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), path, output], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return readFileSync(output, "utf8");
}

test("filesystem options module exports the helper factory expected by node:fs", () => {
  const generated = emit(join(root, "crates/bunwasm-runtime/src/js/fs_options.ts"));
  // oxlint-disable-next-line no-eval -- Initialize the emitted module as bootstrap's internal.require does.
  const createOptions = (0, eval)(generated)({ native: {} });
  expect(typeof createOptions).toBe("function");
  const { Stats, flagsNumber } = createOptions({}, (path: string) => path);
  expect(flagsNumber("wx")).toBe(705);
  expect(new Stats(0, 0o100640).isFile()).toBe(true);
});

test("erases types without printing constructors or moving source positions", () => {
  const text = '(function (value: string) { "use strict"; throw new TypeError(value); })\n';
  writeFileSync(join(source, "position.ts"), text);
  const generated = emit(join(source, "position.ts"));
  expect(generated)
    .toBe('(function (value        ) { "use strict"; throw new TypeError(value); })\n');
});

test("empties type-only lines and keeps template text and every other position", () => {
  const text = [
    "(function (value: string) {",
    "  type Local = { a: string };",
    "  interface Shape {",
    "    b: number;",
    "  }",
    "  ",
    "  const kept = `",
    "   ",
    "  ${value as string}`;",
    "  return kept as string;",
    "})",
    "",
  ].join("\n");
  writeFileSync(join(source, "blank.ts"), text);
  expect(emit(join(source, "blank.ts")).split("\n")).toEqual([
    "(function (value        ) {",
    "",
    "",
    "",
    "",
    "  ",
    "  const kept = `",
    "   ",
    "  ${value          }`;",
    "  return kept          ;",
    "})",
    "",
  ]);
});

test("converted Glob preserves replacement error classes and their stacks", async () => {
  const { runInNewContext } = await import("node:vm");
  const generated = emit(join(root, "crates/bunwasm-runtime/src/js/glob.ts"));
  class ReplacementError extends Error { name = "ReplacementError"; }
  class ReplacementTypeError extends Error { name = "ReplacementTypeError"; }
  const factory = runInNewContext(generated, {
    TypeError: ReplacementTypeError, Error: ReplacementError, process: { cwd: () => "/" },
  }, { filename: "bun-wasm:glob" });
  const { Glob } = factory({ native: {}, require: () => ({ resolve: (cwd: string) => cwd }) });
  const cases: [() => unknown, new (message?: string) => Error, string][] = [
    [() => new Glob(), ReplacementTypeError, "Glob.constructor: expected 1 arguments, got 0"],
    [() => new Glob(7), ReplacementTypeError, "Glob.constructor: first argument is not a string"],
    [() => new Glob("*").match(), ReplacementTypeError, "Glob.matchString: expected 1 arguments, got 0"],
    [() => new Glob("*").match(7), ReplacementTypeError, "Glob.matchString: first argument is not a string"],
    [() => new Glob("*").scanSync(false), ReplacementTypeError, "Expected options to be an object"],
    [() => new Glob("*").scanSync({ cwd: false }), ReplacementTypeError, "Expected cwd to be a string"],
    [() => new Glob("*").scanSync({ cwd: "/".repeat(4097) }), ReplacementError, "ENAMETOOLONG: name too long, scandir"],
  ];
  for (const [trigger, Ctor, message] of cases) {
    let error: unknown;
    try { trigger(); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Ctor);
    if (!(error instanceof Error)) throw new Error("Expected an Error instance");
    expect(Object.getPrototypeOf(error)).toBe(Ctor.prototype);
    expect(error.name).toBe(Ctor === ReplacementError ? "ReplacementError" : "ReplacementTypeError");
    expect(error.message).toBe(message);
    expect(error.stack).toContain("bun-wasm:glob");
  }
});

test("type erasure keeps every source position", () => {
  const path = join(root, "crates/bunwasm-runtime/src/js/glob.ts");
  const text = readFileSync(path, "utf8");
  const generated = emit(path);
  expect(generated.length).toBe(text.length);
  expect(generated.split("\n").length).toBe(text.split("\n").length);
  for (const token of ["new TypeError(", "new Error(", "class Glob", "#pattern", "scanSync("]) {
    let cursor = text.indexOf(token);
    while (cursor !== -1) {
      expect(generated.slice(cursor, cursor + token.length)).toBe(token);
      cursor = text.indexOf(token, cursor + token.length);
    }
  }
});

function compact(text: string) {
  const input = join(source, "compact-input.js");
  const output = join(source, "compact-output.js");
  writeFileSync(input, text);
  const result = Bun.spawnSync(["bun", join(root, "scripts/transpile-runtime.ts"), "--minify-whitespace", input, output], { stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, output: result.exitCode === 0 ? readFileSync(output, "utf8") : "" };
}

test("minifying drops whitespace and comments but keeps names, directives and the factory form", () => {
  const { exitCode, output } = compact([
    "// Leading comment.",
    "(function (internal) {",
    '  "use strict";',
    "  /* Block comment. */",
    "  function namedHelper(value) {",
    '    "use strict";',
    "    return value + internal.offset;",
    "  }",
    '  const text = "keeps  spacing // and use strict text";',
    "  return { namedHelper, text };",
    "})",
    "",
  ].join("\n"));
  expect(exitCode).toBe(0);
  expect(output).toBe('(function(internal){"use strict";function namedHelper(value){"use strict";return value+internal.offset}const text="keeps  spacing // and use strict text";return{namedHelper,text}})\n');
  // oxlint-disable-next-line no-eval -- Exercise the emitted classic-script factory.
  const { namedHelper, text } = (0, eval)(output)({ offset: 2 });
  expect(namedHelper.name).toBe("namedHelper");
  expect(namedHelper(1)).toBe(3);
  expect(text).toBe("keeps  spacing // and use strict text");
});

test("minifying keeps a module that is not strict, and strict mode where it is declared", () => {
  const { output } = compact("(function () { function sloppy() { return this; } function strict() { 'use strict'; return this; } return [sloppy, strict]; })\n");
  // oxlint-disable-next-line no-eval -- Exercise the emitted classic-script factory.
  const [sloppy, strict] = (0, eval)(output)();
  expect(sloppy()).toBe(globalThis);
  expect(strict()).toBeUndefined();
});

test("minifying skips erased declarations and keeps notices, including ordinary comments", () => {
  const { exitCode, output } = compact([
    "/* Nothing special here. */",
    ";",
    "/*! Copyright (c) Example. Keep this notice. */",
    "/*",
    " * Permission is hereby granted. Portions Copyright Someone Else.",
    " */",
    "// MIT-licensed port, one line.",
    "(function () { return 1; })",
    "/*! Trailing notice. */",
    "",
  ].join("\n"));
  expect(exitCode).toBe(0);
  expect(output).toBe([
    "/*! Copyright (c) Example. Keep this notice. */",
    "/*\n * Permission is hereby granted. Portions Copyright Someone Else.\n */",
    "// MIT-licensed port, one line.",
    "(function(){return 1})",
    "/*! Trailing notice. */",
    "",
  ].join("\n"));
});

test("minifying keeps the notices of the shipped modules that carry them", () => {
  for (const name of ["http2_request", "http2_response", "tls_identity"]) {
    const output = join(source, `${name}.min.js`);
    const result = Bun.spawnSync(["bun", join(root, "scripts/transpile-runtime.ts"), "--minify-whitespace", join(root, `crates/bunwasm-runtime/src/js/${name}.ts`), output], { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(output, "utf8")).toMatch(/Copyright (Node\.js contributors|Joyent)/);
  }
});

test("minifying leaves an escaped string that looks like a directive alone and refuses a parenthesized one", () => {
  const { exitCode, output } = compact('(function () { const text = "\\x75se strict"; return [this === globalThis, text]; })\n');
  expect(exitCode).toBe(0);
  // oxlint-disable-next-line no-eval -- Exercise the emitted classic-script factory.
  const [sloppy, text] = (0, eval)(output).call(undefined);
  expect(sloppy).toBe(true);
  expect(text).toBe("use strict");
  // Bun prints a parenthesized string statement bare, which can make it a directive.
  expect(compact('(function () { ("other"); "use strict"; return this; })\n').exitCode).not.toBe(0);
  expect(compact('(function () { ("use strict"); return this; })\n').exitCode).not.toBe(0);
});

test("minifying finds directives exactly: comments, line breaks, templates and parentheses", () => {
  const lineSeparator = String.fromCharCode(0x2028);
  const cases: [string, unknown][] = [
    ['// Keep strict!\n"use strict";\nreturn this;', undefined],
    ['/* c */ "use strict" /* d */\nreturn this;', undefined],
    [`"use strict"\rreturn this;`, undefined],
    [`"use strict"${lineSeparator}return this;`, undefined],
    ["'use strict'\nreturn this;", undefined],
    ['"use strict"\n!0; return this;', undefined],
    ['"use strict"\n++n; var n = 0; return this;', undefined],
    ['"custom"\n"use strict"\nreturn this;', undefined],
    ['let n = 1; n++ / 2; return this === globalThis && ({ return: 4 }).return / 2 === 2;', true],
    ['return typeof "use strict" === "string" ? this === globalThis : false;', true],
    ['return `a ${"x"} \'use strict\'; b`;', "a x 'use strict'; b"],
    ['const re = /"use strict"[\'/]/; return [re.test(\'"use strict"/\'), "/*"];', [true, "/*"]],
    ['"use strict"; return (function () { return this; })();', undefined],
  ];
  for (const [body, expected] of cases) {
    const { exitCode, output } = compact(`(function () {\n${body}\n})\n`);
    expect(exitCode, body).toBe(0);
    // oxlint-disable-next-line no-eval -- Exercise the emitted classic-script factory.
    expect((0, eval)(output).call(undefined), body).toEqual(expected);
  }
});

test("minifying accepts a trailing notice after a factory that holds comment-like strings", () => {
  const { exitCode, output } = compact('(function () { return "/*"; })\n/*! Notice */\n');
  expect(exitCode).toBe(0);
  expect(output).toBe('(function(){return"/*"})\n/*! Notice */\n');
});

test("minifying parses the factory but never runs it, and refuses what is not a function", () => {
  const { exitCode, output } = compact("(function () { return guestOnlyGlobal.make(); })\n");
  expect(exitCode).toBe(0);
  expect(output).toContain("guestOnlyGlobal");
  // A call of a function is not a factory, and neither is a value.
  expect(compact("(function () { return 7; })()\n").exitCode).not.toBe(0);
  expect(compact("((1 + 2) * 3)\n").exitCode).not.toBe(0);
});

test("minifying runs side by side in one output directory", async () => {
  const names = ["first", "second"];
  for (const name of names) writeFileSync(join(source, `${name}.ts`), `(function (value: number) { return value + "${name}".length; })\n`);
  const children = names.map(name => Bun.spawn(["bun", join(root, "scripts/transpile-runtime.ts"), "--minify-whitespace", join(source, `${name}.ts`), join(source, `${name}.out.js`)], { stdout: "pipe", stderr: "pipe" }));
  expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0]);
  // oxlint-disable-next-line no-eval -- Exercise the emitted classic-script factory.
  expect((0, eval)(readFileSync(join(source, "second.out.js"), "utf8"))(1)).toBe(7);
});

test("minifying accepts comments at the end of a directive and a bare-CR line comment", () => {
  const { exitCode, output } = compact('// first\r(function () {\n  "use strict" // keep\n  return this;\n})\n');
  expect(exitCode).toBe(0);
  // oxlint-disable-next-line no-eval -- Exercise the emitted classic-script factory.
  expect((0, eval)(output).call(undefined)).toBeUndefined();
});

/** Every directive prologue in `code`, in source order, one entry per function body or block that has one. */
function directivePrologues(code: string): string[][] {
  const file = ts.createSourceFile("module.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found: string[][] = [];
  const visit = (node: ts.Node) => {
    const statements = ts.isSourceFile(node) || ts.isBlock(node) ? node.statements : undefined;
    if (statements) {
      const directives = [];
      for (const statement of statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression) || statement.expression.parent !== statement) break;
        directives.push(statement.expression.text);
      }
      if (directives.length > 0) found.push(directives);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test("minifying keeps every directive prologue of every runtime module, as a real parser sees them", () => {
  const sources = readdirSync(join(root, "crates/bunwasm-runtime/src/js"))
    .filter(name => /\.(js|ts)$/.test(name) && !name.endsWith(".d.ts") && !/^(intl|tz_data)\./.test(name));
  expect(sources.length).toBeGreaterThan(150);
  const pairs = sources.flatMap(name => [join(root, "crates/bunwasm-runtime/src/js", name), join(source, `all-${name}.js`)]);
  const result = Bun.spawnSync(["bun", join(root, "scripts/transpile-runtime.ts"), "--batch", ...pairs, "--minify-whitespace"], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString().slice(-2000)).toBe(0);
  let directives = 0;
  for (const name of sources) {
    const original = join(source, `erased-${name}.js`);
    const erased = name.endsWith(".ts")
      ? Bun.spawnSync(["node", join(root, "scripts/transpile-runtime.ts"), join(root, "crates/bunwasm-runtime/src/js", name), original], { stdout: "pipe", stderr: "pipe" })
      : undefined;
    const before = erased ? readFileSync(original, "utf8") : readFileSync(join(root, "crates/bunwasm-runtime/src/js", name), "utf8");
    const after = readFileSync(join(source, `all-${name}.js`), "utf8");
    const expected = directivePrologues(before);
    expect(directivePrologues(after), name).toEqual(expected);
    directives += expected.flat().length;
  }
  expect(directives).toBeGreaterThan(100);
});

/** Whether `node` sits in code that a "use strict" directive of an enclosing function or the script makes strict. */
function inStrictCode(node: ts.Node): boolean {
  for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
    const body = ts.isFunctionLike(scope) ? (scope as ts.FunctionLikeDeclaration).body : ts.isSourceFile(scope) ? scope : undefined;
    const statements = body && (ts.isBlock(body) || ts.isSourceFile(body)) ? body.statements : [];
    const first = statements[0];
    if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use strict") return true;
  }
  return false;
}

test("no sloppy runtime module declares a function inside a nested block, where Bun's reprint scopes it differently", () => {
  const directory = join(root, "crates/bunwasm-runtime/src/js");
  for (const name of readdirSync(directory).filter(entry => /\.(js|ts)$/.test(entry) && !entry.endsWith(".d.ts") && !/^(intl|tz_data)\./.test(entry))) {
    const file = ts.createSourceFile(name, readFileSync(join(directory, name), "utf8"), ts.ScriptTarget.Latest, true, name.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const nested: string[] = [];
    const visit = (node: ts.Node) => {
      const parent = node.parent;
      const inBlock = ts.isFunctionDeclaration(node) && parent && ts.isBlock(parent) && !ts.isFunctionLike(parent.parent);
      if (inBlock && !inStrictCode(node)) nested.push(node.name?.text ?? "default");
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(nested, name).toEqual([]);
  }
});

test("minifying rejects a module that does not start with its factory", () => {
  expect(compact("const first = 1;\n(function () { return first; })\n").exitCode).not.toBe(0);
  expect(compact("(function () { return 1; })\n;trailing();\n").exitCode).not.toBe(0);
  expect(compact("(42)\n").exitCode).not.toBe(0);
});

test("builtin helper prepares runnable globals from the TypeScript factory", async () => {
  const directory = join(source, "builtins");
  const result = Bun.spawnSync(["bash", join(root, "scripts/test-bun-builtins.sh"), "--prepare-only", directory], {
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const { runInNewContext } = await import("node:vm");
  const globals = runInNewContext(readFileSync(join(directory, "globals.js"), "utf8"), { Buffer })();
  expect(Object.isFrozen(globals)).toBe(true);
  expect(globals.Buffer).toBe(Buffer);
  expect(globals.Array.isArray([])).toBe(true);
  expect(JSON.parse(readFileSync(join(directory, "catalog.json"), "utf8"))).toBeDefined();
});

test("converted byte sink keeps its factory and copied-buffer behavior", async () => {
  const { runInNewContext } = await import("node:vm");
  const generated = emit(join(root, "crates/bunwasm-runtime/src/js/array_buffer_sink.ts"));
  const factory = runInNewContext(generated, { Uint8Array, ArrayBuffer, SharedArrayBuffer, DataView });
  const { ArrayBufferSink } = factory({
    native: { utf8Encode: (value: string) => new TextEncoder().encode(value) },
    concatBytes(chunks: Uint8Array[]) {
      const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    },
  });
  const sink = new ArrayBufferSink();
  sink.start({ stream: true, asUint8Array: true });
  const input = Uint8Array.of(1, 2, 3);
  expect(sink.write(input)).toBe(3);
  input.fill(9);
  expect(Array.from(sink.flush())).toEqual([1, 2, 3]);
  expect(sink.write("ok")).toBe(2);
  expect(Array.from(sink.end())).toEqual([111, 107]);
  sink.close();
  expect(() => sink.write("no")).toThrow("already been closed");
});

test("converted Function adapter preserves construction and module origins", async () => {
  const { createContext, runInContext } = await import("node:vm");
  const context = createContext({ process: { pid: 1, env: {} }, performance });
  const generated = emit(join(root, "crates/bunwasm-runtime/src/js/function.ts"));
  const factory = runInContext(generated, context);
  const resolutions: unknown[][] = [];
  const internal = {
    native: {
      engine: "quickjs",
      prepareFunction: (strings: string[]) => JSON.stringify(strings.map(source => ({
        version: 6, alreadyPrepared: false, edits: source.includes("import") ? [source.indexOf("import"), 6, 16] : [],
        columns: [], fallback: null, spreadEval: 0, unhookedAwaitUsing: 0,
      }))),
      resolveImport(...args: unknown[]) { resolutions.push(args); return "/loaded.ts"; },
      importModule: async (path: string) => ({ path }),
    },
    mainPath: "/entry.ts",
    require: () => ({ "bun:jsc": () => ({ callerSourceOrigin: () => "/entry.ts" }) }),
    defineGlobal(name: string, value: unknown) { context[name] = value; },
  };
  runInContext(emit(join(root, "crates/bunwasm-runtime/src/js/source_prepare.ts")), context)(internal);
  runInContext(emit(join(root, "crates/bunwasm-runtime/src/js/import_requests.ts")), context)(internal);
  factory(internal);
  expect(runInContext('new Function("return 7")()', context)).toBe(7);
  expect(() => runInContext('new Function("return @")', context)).toThrow();
  expect(await runInContext('new Function("return import(\\\"./leaf\\\")")()', context)).toEqual({ path: "/loaded.ts" });
  expect(resolutions).toEqual([["./leaf", "/entry.ts", "inferred"]]);
});

test("prepared spread eval preserves concurrent context and iterable semantics", async () => {
  const { createContext, runInContext } = await import("node:vm");
  let frame = "none";
  const context = createContext({ process: { pid: 1, env: {} }, performance });
  Object.assign(context, {
    __bunwasm_capture: () => frame,
    __bunwasm_resume(saved: string, value: unknown) { frame = saved; return value; },
    __bunwasmSpreadFrame: () => frame,
  });
  const evaluated = "(async () => { await 0; return globalThis.__bunwasmSpreadFrame(); })()";
  const native = {
    engine: "host", contextHooks: true, prepareVersion: 6,
    preparedColumns: new Map(),
    prepareSource(source: string) {
      const values = source.indexOf("values");
      const awaitAt = source.indexOf("await");
      const edits = source === "eval(...values)"
        ? [values, 0, 18, values + "values".length, 0, 1]
        : [awaitAt, 0, 0, source.indexOf("0", awaitAt) + 1, 0, 1];
      return JSON.stringify({ version: 6, alreadyPrepared: false, edits, columns: [], fallback: null,
        spreadEval: source === "eval(...values)" ? 1 : 0, unhookedAwaitUsing: 0 });
    },
  };
  const internal = {
    native,
    mainPath: "/spread.ts",
    require: () => ({ "bun:jsc": () => ({ callerSourceOrigin: () => "/spread.ts" }) }),
    defineGlobal(name: string, value: unknown) { context[name] = value; },
  };
  const install = runInContext(emit(join(root, "crates/bunwasm-runtime/src/js/source_prepare.ts")), context);
  const preparation = install(internal);
  const call = preparation.prepareText("eval(...values)", "eval", "spread-test");
  expect(call).toBe("eval(...__bunwasm_evalSpread(eval, values))");
  const callable = runInContext(`new Function("values", ${JSON.stringify(`return ${call}`)})`, context);
  const request = (name: string) => {
    frame = name;
    return callable([evaluated]);
  };
  expect(await Promise.all([request("A"), request("B")])).toEqual(["A", "B"]);
  const raw = runInContext(`new Function("values", "return eval(...values)")`, context);
  const rawRequest = (name: string) => {
    frame = name;
    return raw([evaluated]);
  };
  expect(await Promise.all([rawRequest("A"), rawRequest("B")])).not.toEqual(["A", "B"]);
  expect(callable([])).toBeUndefined();
  expect(callable([19, "ignored"])).toBe(19);
  const nativeEval = context.eval;
  const customCalls: unknown[][] = [];
  try {
    context.eval = (...values: unknown[]) => {
      customCalls.push(values);
      return "custom";
    };
    expect(callable(["await 0", 19])).toBe("custom");
    expect(customCalls).toEqual([["await 0", 19]]);
  } finally {
    context.eval = nativeEval;
  }
  const failure = { marker: "same error" };
  const bad = { [Symbol.iterator]() { return { next() { throw failure; } }; } };
  let caught: unknown;
  try {
    callable(bad);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
});
