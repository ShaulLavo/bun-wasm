import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const erased = Bun.spawnSync(["node", "--input-type=module", "-e",
  'import { stripTypeScriptTypes } from "node:module"; let text = ""; for await (const chunk of process.stdin) text += chunk; process.stdout.write(stripTypeScriptTypes(text));'],
{ stdin: Buffer.from(readFileSync(new URL("../crates/bunwasm-runtime/src/js/caller_origin.ts", import.meta.url), "utf8")), stdout: "pipe", stderr: "pipe" });
if (erased.exitCode !== 0) throw new Error(erased.stderr.toString());
const source = erased.stdout.toString();

function callerOrigin(frames: unknown, engine = "spidermonkey") {
  const context = createContext({ frames });
  runInContext(`globalThis[Symbol.for("bunwasm.internal.spidermonkey.errorFrames")] = () => frames`, context);
  const factory = runInContext(source, context);
  const origin = factory({
    native: { engine },
    pathToFileHref: (path: string) => new URL(`file://${path}`).href,
  });
  return origin();
}

for (const kind of ["eval", "Function", "AsyncFunction", "GeneratorFunction", "AsyncGenerator"]) {
  test(`SpiderMonkey stops at an opaque ${kind} frame before an unrelated caller`, () => {
    expect(callerOrigin([
      { file: "bun-wasm:caller_origin" },
      { file: `/helper.mjs line 13 > ${kind}` },
      { file: "/index.js" },
    ])).toBeNull();
    expect(callerOrigin([
      { file: `bun-wasm:function line 17 > ${kind}` },
      { file: "/index.js" },
    ])).toBeNull();
  });
}

for (const file of ["/helper.mjs", "/name@host.mjs", "/line 13 > eval.mjs",
  "/space # ü.mjs", "file:///eval-created.mjs", "https://example.invalid/eval-created.mjs"]) {
  test(`SpiderMonkey preserves the source filename or sourceURL ${file}`, () => {
    expect(callerOrigin([{ file: "bun-wasm:caller_origin" }, { file }, { file: "/index.js" }]))
      .toBe(file.startsWith("/") ? new URL(`file://${file}`).href : file);
  });
}

test("SpiderMonkey stops at unavailable source data", () => {
  for (const frames of [undefined, [], [{ file: "" }, { file: "/index.js" }], [{ file: null }, { file: "/index.js" }]]) {
    expect(callerOrigin(frames)).toBeNull();
  }
});
