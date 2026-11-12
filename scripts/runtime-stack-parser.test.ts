import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface StackFrame {
  name: string;
  file: string;
  line: number;
  column: number;
}

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/inspect.js", import.meta.url), "utf8");

function inspector(engine: string, hooks: object = {}, frames?: (error: unknown, stack: unknown) => unknown) {
  const factory: (internal: object) => {
    parseStack(stack: unknown): StackFrame[];
    formatError(error: unknown): string;
  } = runInNewContext('globalThis[Symbol.for("bunwasm.internal.spidermonkey.errorFrames")] = errorFrames;\n' + source, { errorFrames: frames }, { filename: "bun-wasm:inspect" });
  return factory({ native: { engine, preparedSourceName: () => undefined }, ...hooks });
}

// Retained dev failure stack from the 3cd/c276 JSC attempt, not the lost triggering stack.
const retainedStack = `parseJscFrameLine@bun-wasm:inspect:1412:29
parseStack@bun-wasm:inspect:1390:35
formatStack@bun-wasm:stack_trace:1:2215
getStack@/home/user/node_modules/next/dist/compiled/send/index.js:7:3587
depd@/home/user/node_modules/next/dist/compiled/send/index.js:7:878
809@/home/user/node_modules/next/dist/compiled/send/index.js:41:16
__nccwpck_require__@/home/user/node_modules/next/dist/compiled/send/index.js:70:34022
744@/home/user/node_modules/next/dist/compiled/send/index.js:59:11
__nccwpck_require__@/home/user/node_modules/next/dist/compiled/send/index.js:70:34022
@/home/user/node_modules/next/dist/compiled/send/index.js:70:34212
__bunwasm_cjs__@/home/user/node_modules/next/dist/compiled/send/index.js:70:34236
evaluateModule@bun-wasm:bootstrap:604:22
loadModule@bun-wasm:bootstrap:570:21
requireFrom@bun-wasm:bootstrap:632:22
__bunwasm_cjs__@/home/user/node_modules/next/dist/server/serve-static.js:27:61
evaluateModule@bun-wasm:bootstrap:604:22
loadModule@bun-wasm:bootstrap:570:21
requireFrom@bun-wasm:bootstrap:632:22
__bunwasm_cjs__@/home/user/node_modules/next/dist/server/lib/router-server.js:18:29
evaluateModule@bun-wasm:bootstrap:604:22
loadModule@bun-wasm:bootstrap:570:21
requireFrom@bun-wasm:bootstrap:632:22
__bunwasm_cjs__@/home/user/node_modules/next/dist/server/lib/start-server.js:39:30
evaluateModule@bun-wasm:bootstrap:604:22
runMain@bun-wasm:bootstrap:712:21`;

for (const engine of ["jsc", "host", "quickjs"]) {
  test(`${engine} parses retained JSC frames without an ambient native binding`, () => {
    const frames = inspector(engine).parseStack(retainedStack);
    expect(frames).toHaveLength(11);
    expect(frames[0]).toEqual({
      name: "getStack", file: "/home/user/node_modules/next/dist/compiled/send/index.js", line: 7, column: 3587,
    });
    expect(frames.map(frame => frame.name)).toEqual([
      "getStack", "depd", "809", "__nccwpck_require__", "744", "__nccwpck_require__", "<anonymous>", "", "", "", "",
    ]);
  });
}

for (const generated of [false, true]) {
  test(`JSC-style source mapping preserves the ${generated ? "prepared" : "ordinary"} frame contract`, () => {
    const rawFile = "/prepared/module.js";
    const file = "/home/user/source.ts";
    const mappings: unknown[][] = [];
    const lookups: unknown[][] = [];
    const parsed = inspector("host", {
      native: { engine: "host", preparedSourceName: (name: string) => generated && name === rawFile ? file : undefined },
      displayName: () => file,
      mapPosition: (...args: unknown[]) => { mappings.push(args); return [17, 9]; },
      getSourceLine: (...args: unknown[]) => { lookups.push(args); return "  invoke("; },
    }).parseStack(`run@${rawFile}:2:3`);
    expect(parsed).toEqual([{ name: "run", file, line: 17, column: generated ? 9 : 3 }]);
    expect(mappings).toEqual([[generated ? rawFile : file, 2, 3]]);
    expect(lookups).toEqual(generated ? [] : [[file, 17]]);
  });
}

test("formatting retains the original application exception and parsed frames", () => {
  const error = new Error("original application failure");
  error.name = "TypeError";
  error.stack = retainedStack;
  const formatted = inspector("jsc").formatError(error);
  expect(formatted).toContain("TypeError: original application failure");
  expect(formatted).toContain("at getStack (/home/user/node_modules/next/dist/compiled/send/index.js:7:3587)");
  expect(formatted).not.toContain("native is not defined");
  expect(formatted).not.toContain("bun-wasm:inspect");
  expect(error.message).toBe("original application failure");
  expect(error.stack).toBe(retainedStack);
});

const spiderMonkeyStack = `fail@/index.js:5:9
async*__bunwasm_cjs__@/index.js:7:1
callModuleWrapper@bun-wasm:bootstrap:615:22
`;

test("SpiderMonkey uses saved frames without changing raw async allocation ancestry", () => {
  const mappings: unknown[][] = [];
  const lookups: unknown[][] = [];
  const stack = inspector("spidermonkey", {
    mapPosition: (...position: unknown[]) => { mappings.push(position); return [5, 9]; },
    getSourceLine: (...position: unknown[]) => { lookups.push(position); return '  throw new Error("async failure");'; },
  }, () => [{ name: "fail", file: "/index.js", line: 2, column: 3 }]);
  expect(stack.parseStack("fail@/index.js:2:3")).toEqual([{ name: "fail", file: "/index.js", line: 5, column: 13 }]);
  expect(mappings).toEqual([["/index.js", 2, 3]]);
  expect(lookups).toEqual([["/index.js", 5]]);
  const error = new Error("original rejection");
  error.stack = spiderMonkeyStack;
  expect(stack.formatError(error)).toContain("at fail (/index.js:5:13)");
  expect(stack.formatError(error)).not.toContain("__bunwasm_cjs__");
  expect(error.message).toBe("original rejection");
  expect(error.stack).toBe(spiderMonkeyStack);
});

test("SpiderMonkey retains synchronous CommonJS callers and does not reinterpret ordinary call columns", () => {
  const stack = inspector("spidermonkey", { getSourceLine: () => "function fail() { invoke(); }" });
  expect(stack.parseStack("fail@/index.js:1:24\n__bunwasm_cjs__@/index.js:2:1")).toEqual([
    { name: "fail", file: "/index.js", line: 1, column: 24 },
    { name: "", file: "/index.js", line: 2, column: 1 },
  ]);
});

for (const text of ["  throw newer();", "  throw value;", "", undefined]) {
  test(`SpiderMonkey leaves non-constructor locations unchanged for ${JSON.stringify(text)}`, () => {
    const stack = inspector("spidermonkey", { getSourceLine: () => text });
    expect(stack.parseStack("fail@/index.js:1:9")[0]?.column).toBe(9);
  });
}

for (const engine of ["quickjs", "jsc", "host"]) {
  test(`${engine} does not apply SpiderMonkey constructor or async-ancestry rules`, () => {
    const stack = inspector(engine, { getSourceLine: () => '  throw new Error("async failure");' });
    expect(stack.parseStack(spiderMonkeyStack)).toEqual([
      { name: "fail", file: "/index.js", line: 5, column: 9 },
      { name: "async*__bunwasm_cjs__", file: "/index.js", line: 7, column: 1 },
    ]);
    expect(stack.parseStack("    at fail (/index.js:5:9)")).toEqual([{ name: "fail", file: "/index.js", line: 5, column: 9 }]);
  });
}

test("SpiderMonkey maps anonymous module bodies without inventing a function name", () => {
  expect(inspector("spidermonkey").parseStack("@/entry.mjs:3:1")).toEqual([
    { name: "", file: "/entry.mjs", line: 3, column: 1 },
  ]);
});

for (const name of ["async*sync", "at sync", "async*__bunwasm_cjs__"]) {
  test(`SpiderMonkey preserves synchronous native display name ${name}`, () => {
    const stack = inspector("spidermonkey");
    expect(stack.parseStack(`${name}@/index.cjs:10:29\nresult@/index.cjs:3:17`)).toEqual([
      { name, file: "/index.cjs", line: 10, column: 29 },
      { name: "result", file: "/index.cjs", line: 3, column: 17 },
    ]);
    expect(stack.parseStack(`result@/index.cjs:3:17\n${name}@/index.cjs:10:29`)[1]?.name).toBe(name);
  });
}
for (const line of ['  throw new /* comment */ Error("failure");', '  throw new // comment', '  throw new', '  throw new\nError("failure");']) {
  test(`SpiderMonkey conservatively keeps constructor position for ${JSON.stringify(line)}`, () => {
    expect(inspector("spidermonkey", { getSourceLine: () => line }).parseStack("fail@/index.js:1:9")[0]?.column).toBe(9);
  });
}
test("SpiderMonkey saved-frame formatting keeps display name and source separate", () => {
  const error = new Error("original");
  const raw = "at sync@/index.cjs:10:29\nasync*creation@/outer.js:2:1";
  error.stack = raw;
  const frames = [{ name: "at sync", file: "/index.cjs", line: 10, column: 29 }];
  const stack = inspector("spidermonkey", {}, (value, observed) => {
    expect(value).toBe(error); expect(observed).toBe(raw); return frames;
  });
  expect(stack.formatError(error)).toContain("at at sync (/index.cjs:10:29)");
  expect(stack.formatError(error)).not.toContain("creation");
  expect(error.stack).toBe(raw);
});
test("SpiderMonkey preserves overridden stack text or a failed metadata read", () => {
  const error = new Error("custom"); error.stack = "async*sync@/custom.js:4:7";
  for (const read of [() => undefined, () => { throw new Error("metadata unavailable"); }]) {
    expect(inspector("spidermonkey", {}, read).formatError(error)).toContain("at async*sync (/custom.js:4:7)");
    expect(error.stack).toBe("async*sync@/custom.js:4:7");
  }
});

test("SpiderMonkey keeps a user-supplied V8 stack when native metadata does not apply", () => {
  const error = new Error("custom"); error.stack = "    at custom (/custom.js:4:7)";
  const stack = inspector("spidermonkey", {}, () => undefined);
  expect(stack.formatError(error)).toContain("at custom (/custom.js:4:7)");
  expect(error.stack).toBe("    at custom (/custom.js:4:7)");
});
