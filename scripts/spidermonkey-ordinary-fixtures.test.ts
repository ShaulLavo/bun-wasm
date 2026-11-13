import { test } from "bun:test";
import { resolve } from "node:path";
import { ordinaryFixtureTimeout, runOrdinaryFixtures } from "./spidermonkey-ordinary-fixtures.ts";

test("ordinary SpiderMonkey PBL fixtures", () => {
  runOrdinaryFixtures(resolve(import.meta.dir, ".."));
}, ordinaryFixtureTimeout);
