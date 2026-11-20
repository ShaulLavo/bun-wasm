import { test } from "bun:test";
import { resolve } from "node:path";
import { ordinaryFixtureTimeout, runAdapterControls, runOrdinaryFixtures } from "./spidermonkey-ordinary-fixtures.ts";

test("SpiderMonkey adapter controls on both tiers", () => {
  runAdapterControls(resolve(import.meta.dir, ".."));
}, ordinaryFixtureTimeout);

for (const tier of ["interp", "pbl"] as const) {
  test(`ordinary SpiderMonkey ${tier} fixtures`, () => {
    runOrdinaryFixtures(resolve(import.meta.dir, ".."), tier);
  }, ordinaryFixtureTimeout);
}
