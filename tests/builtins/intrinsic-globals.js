import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const adapter = eval(readFileSync("runtime.js", "utf8"));
const builtinGlobals = eval(readFileSync("globals.js", "utf8"))();

function check(name, phase) {
  const saved = globalThis[name];
  let compiles = 0;
  const native = {
    bunBuiltinNames: () => ["internal:globals-test"],
    bunBuiltinSource: () => "test",
    evalScript() {
      compiles++;
      return intrinsics => () => assert.equal(intrinsics[name], saved);
    },
  };
  try {
    if (phase === "before") globalThis[name] = function () { throw Error(`poisoned ${name}`); };
    const runtime = adapter({ native, bunBuiltinGlobals: builtinGlobals });
    assert.equal(compiles, 0);
    const run = runtime.require(0);
    if (phase === "after") globalThis[name] = function () { throw Error(`poisoned ${name}`); };
    run();
    assert.equal(runtime.require(0), run);
    assert.equal(compiles, 1);
  } finally {
    globalThis[name] = saved;
  }
}

for (const name of ["String", "Buffer"]) {
  for (const phase of ["before", "after"]) check(name, phase);
}
console.log("Bun intrinsic globals survive overrides before and after import");
