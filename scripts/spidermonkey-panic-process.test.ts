import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runPanicProcessControls } from "./spidermonkey-panic-process.ts";

test("the selected SpiderMonkey process reports a panic and exits fatally", () => {
  const core = process.env.SPIDERMONKEY_WASM;
  const launcher = process.env.BUN_WASM_LAUNCHER;
  const build = process.env.SPIDERMONKEY_ENGINE_BUILD_DIR;
  assert(core && launcher && build, "Provide the normal SpiderMonkey producer and launcher inputs");
  const map = readFileSync(join(build, "engine-link.map"), "utf8");
  const archive = map.match(/\S*libbunwasm_engine_spidermonkey\.a(?=\()/)?.[0];
  assert(archive, "The normal side link map must name its engine archive");
  runPanicProcessControls({ core, launcher, build, archive });
}, 600_000);
