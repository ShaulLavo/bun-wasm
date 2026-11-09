import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const preload = resolve(import.meta.dir, "measure-require-depth.ts");
const scratch = mkdtempSync(join(process.env.BUN_WASM_SCRATCH_ROOT ?? tmpdir(), "bun-wasm-measure-require-depth-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

writeFileSync(join(scratch, "entry.mjs"), 'import "./a.cjs";\nconsole.log("application started");\n');
writeFileSync(join(scratch, "a.cjs"), 'require("./b.cjs");\n');
writeFileSync(join(scratch, "b.cjs"), 'require("node:fs");\nrequire("./leaf.cjs");\n');
writeFileSync(join(scratch, "leaf.cjs"), 'console.log("leaf evaluated");\n');

function measure(targets: string) {
  const result = spawnSync("node", ["--no-warnings", "--import", preload, join(scratch, "entry.mjs")], {
    encoding: "utf8",
    env: { ...process.env, REQUIRE_DEPTH_TARGETS: targets },
    timeout: 20000,
  });
  return { status: result.status, stderr: result.stderr, lines: result.stdout.trimEnd().split("\n") };
}

test("reports the CommonJS chain below an ES module import and stops before the target runs", () => {
  const result = measure("leaf.cjs");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.lines).toHaveLength(1);
  expect(JSON.parse(result.lines[0]!)).toEqual({
    target: "leaf.cjs",
    depth: 3,
    chain: ["a.cjs", "b.cjs", "leaf.cjs"].map((name) => join(scratch, name)),
  });
});

test("keeps the application running while a target has not loaded", () => {
  const result = measure("leaf.cjs,never-loaded.cjs");
  expect(result.status).toBe(0);
  expect(result.lines.slice(1)).toEqual(["leaf evaluated", "application started"]);
  expect(JSON.parse(result.lines[0]!).depth).toBe(3);
});
