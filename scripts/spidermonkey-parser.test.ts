import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { checkParserFrames, parserInstantiations } from "./spidermonkey-parser-frames.ts";
import { expectedPath, runCorpus, tiers } from "./spidermonkey-parser-semantics.ts";
import { standaloneSmoke } from "./spidermonkey-smoke.ts";

// docs/bun-patches/spidermonkey-frontend-frames.md: the parser's statement and expression cycles
// are merged into fewer wasm frames. A lost inline is silent, so check the linked smoke and the
// ordinary engine side directly.
test("SpiderMonkey parser recursion cycles stay merged in the smoke and the engine side", () => {
  const core = process.env.SPIDERMONKEY_WASM;
  assert(core && isAbsolute(core), "Set SPIDERMONKEY_WASM to the ordinary SpiderMonkey pair");
  for (const module of [standaloneSmoke().smoke, join(dirname(core), "spidermonkey-engine.wasm")]) {
    const reports = checkParserFrames(readFileSync(module));
    expect(reports.map(report => report.label)).toEqual(parserInstantiations.map(instantiation => instantiation.label));
  }
}, 440_000);

// The same sources give the same values, errors and positions as the library before the merges,
// and the compile limit accepts and refuses at the same nesting depths.
for (const tier of tiers) {
  test(`SpiderMonkey parser corpus and compile-limit boundaries on ${tier}`, () => {
    expect(runCorpus(standaloneSmoke().smoke, tier)).toBe(readFileSync(expectedPath(tier), "utf8"));
  }, 440_000);
}
