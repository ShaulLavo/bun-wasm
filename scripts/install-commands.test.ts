import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { installFixtureTargets } from "./install-fixture-command";

const root = resolve(import.meta.dir, "..");
// Cases of tests/install/commands.ts that runtime checks run on every install engine.
const cases = ["cacheOffKeepsBunx"];

for (const target of installFixtureTargets()) {
  test(`${target.engine}: ${cases.join(", ")}`, () => {
    const launcher = process.env.BUN_WASM_LAUNCHER ?? join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "release/bun-wasm");
    // Node: the Browser engine's host (web/scripts/node-host.mjs) needs node:module hooks.
    const result = spawnSync("node", ["--no-warnings", join(root, "tests/install/commands.ts")], {
      cwd: root,
      env: { ...process.env, INSTALL_ENGINE: target.engine, BUN_WASM: target.wasm, BUN_WASM_LAUNCHER: launcher, INSTALL_CASES: cases.join(",") },
      encoding: "utf8",
      // Hang cap only.
      timeout: 180_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    for (const name of cases) assert.match(result.stdout, new RegExp(`PASS ${name}\\b`), output);
  }, 200_000);
}
