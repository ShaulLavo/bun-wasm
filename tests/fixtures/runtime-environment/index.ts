import assert from "node:assert/strict";
import { Transpiler } from "bun";
import { environment, resolveMode } from "./mode.ts";

const previousNode = process.env.NODE_ENV;
const previousBun = process.env.BUN_ENV;
try {
  for (const initial of [undefined, "production", "development", "staging"]) {
    if (initial === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = initial;
    const isProduction = initial === undefined || initial === "production";
    assert.deepEqual(resolveMode(), { isNodeEnvSet: initial !== undefined, isProduction, esbuild: { jsxDev: !isProduction } });
  }
  process.env.NODE_ENV = "first";
  process.env.BUN_ENV = "second";
  assert.deepEqual(environment(), ["first", "second"]);
  process.env.NODE_ENV = "third";
  delete process.env.BUN_ENV;
  assert.deepEqual(environment(), ["third", undefined]);

  for (const mode of [undefined, "production", "development"]) {
    const define = mode === undefined ? undefined : { "process.env.NODE_ENV": JSON.stringify(mode) };
    const transpiler = new Transpiler({ loader: "js", target: "bun", define });
    const code = transpiler.transformSync("const mode = process.env.NODE_ENV;");
    assert.equal(new Function(`${code}\nreturn mode;`)(), mode ?? "development");
  }
} finally {
  if (previousNode === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNode;
  if (previousBun === undefined) delete process.env.BUN_ENV;
  else process.env.BUN_ENV = previousBun;
}
console.log("runtime environment stays live; public transpiler defines stay explicit");
