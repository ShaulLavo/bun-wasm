import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { selectChecks } from "./test-checks.ts";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("SpiderMonkey Browser qualification adds direct tier, recursion and reentry controls before the unchanged group assertions", () => {
  const driver = source("web/tests/shared-wasm-memory-browser.ts");
  const entryLoop = driver.indexOf("for (const entry of plan.entries)");
  expect(entryLoop).toBeGreaterThan(-1);
  for (const assertion of ["assertSpiderMonkeyCanary", "assertSpiderMonkeyRecursion", "assertSpiderMonkeyReentry"]) {
    const control = driver.indexOf(`${assertion}(await runEntry`);
    expect(control).toBeGreaterThan(-1);
    expect(control).toBeLessThan(entryLoop);
  }
  expect(driver).toContain('"a refused reentry must leave the callback usable"');
  expect(driver).toContain('tier !== "interp" && tier !== "pbl"');
  expect(driver).toContain('"selected portable baseline never executed"');
  expect(driver).toContain('assert.equal(entries, 0)');
  expect(driver).toContain('verifySpiderMonkeyStackWitness(value.stderr ?? "", value.hostStacks ?? [])');
  const witness = source("scripts/spidermonkey-native-qualification.ts");
  expect(witness).toContain('layout.registerDepth >= 16 && layout.registerDepth <= 65_536');
  expect(witness).toContain('pointer: layout.high, samePointer: true');
  expect(driver).toContain('assert.equal(observed.caught, "RangeError"');
  expect(driver).toContain('"the engine must recover for a second recursive call"');
  expect(driver).toContain('await readFile(join(fixtureSource, "expected-browser.txt"), "utf8")');
  expect(driver).toContain('assert.equal(value.budget, 0');
  expect(driver).toContain('assert.equal(group!.retained, 1)');
});

test("the production shared Browser page forwards the selected SpiderMonkey environment without changing engine policy", () => {
  const main = source("web/tests/shared-wasm-memory-browser-main.ts");
  expect(main).toContain('kind !== "spidermonkey"');
  expect(main).toContain('memoryGroups: BUN_MEMORY_GROUP_POLICY');
  expect(main).toContain('env: { ...engineEnv, PWD:');
  const executor = source("web/src/bun-executor.ts");
  expect(executor).toContain('spiderMonkeyGroupStack(imports, req.memoryGroup.stackBytes)');
  expect(executor).toContain('try { group.initialize(); checkStack?.(); }');
  expect(selectChecks("quality")).toContain("scripts/spidermonkey-browser-stack.test.ts");
  expect(selectChecks("browser-guest", undefined, "shared-group")).toContain("scripts/shared-wasm-memory-browser.test.ts");
});
