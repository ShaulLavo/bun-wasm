import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const source = readFileSync(new URL("../crates/bunwasm-runtime/src/js/esm_loader.ts", import.meta.url), "utf8");
const code = execFileSync("node", ["--disable-warning=ExperimentalWarning", "-e",
  'process.stdout.write(require("node:module").stripTypeScriptTypes(require("node:fs").readFileSync(0,"utf8"), {mode:"strip"}))',
], { input: source, encoding: "utf8" });

test("hot sessions keep pristine intrinsics and do not replace the ordinary import hook", async () => {
  const context = vm.createContext({});
  const result = vm.runInContext(`(async () => {
    const factory = eval(${JSON.stringify(code)});
    let runs = 0;
    const bindings = {
      resolve: name => name,
      initMeta() {},
      load: () => ({ record: { r: [], i: [], x: [], s: [], e: [["run", "run"]], a: false,
        f: function* (api) { const run = ++runs; api.l({ run: () => run }); yield; yield; }
      } })
    };
    const original = factory(bindings);
    const hook = globalThis.__bunwasm_import;
    globalThis.Map = function () { throw new Error("poisoned Map"); };
    globalThis.Promise = function () { throw new Error("poisoned Promise"); };
    const first = original.newSession(bindings);
    const second = original.newSession(bindings);
    const one = await first.importName("/app.ts");
    const again = await first.importName("/app.ts");
    const two = await second.importName("/app.ts");
    return { different: one !== two, same: one === again, runs, hook: hook === globalThis.__bunwasm_import,
      values: [one.run, two.run] };
  })()`, context);
  expect(await result).toEqual({ different: true, same: true, runs: 2, hook: true, values: [1, 2] });
});
