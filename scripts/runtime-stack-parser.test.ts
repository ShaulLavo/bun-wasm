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

function inspector(engine: string, hooks: object = {}) {
  const factory: (internal: object) => {
    parseStack(stack: unknown): StackFrame[];
    formatError(error: unknown): string;
  } = runInNewContext(source, {}, { filename: "bun-wasm:inspect" });
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
