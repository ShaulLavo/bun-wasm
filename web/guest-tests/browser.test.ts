import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { testCompose } from "./compose";

const root = resolve(import.meta.dir, "../..");

test("browser guest preserves require.main when await hooks reprint CommonJS", () => {
  const fixture = resolve(root, "tests/fixtures/module-syntax");
  const wasm = process.env.BUN_WASM_TEST_BROWSER_WASM || resolve(root, "dist/bun-browser.wasm");
  const child = spawnSync("node", ["--no-warnings", resolve(root, "web/scripts/node-host.mjs"),
    "--wasm", wasm, "--dir", `${fixture}::/`, "--env", "PWD=/", "--env", "HOME=/", "--", "run", "/index.js"],
  { cwd: root, encoding: "utf8", timeout: 30000 });
  expect(child.error).toBeUndefined();
  expect(child.stdout).toBe(readFileSync(resolve(fixture, "expected.txt"), "utf8"));
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
}, 30000);

test("fresh Node-hosted WASM subprocesses preserve stdio, cwd, files, exits and signals", () => {
  const child = spawnSync("node", ["--no-warnings", new URL("../tests/subprocess.mjs", import.meta.url).pathname], { cwd: root, encoding: "utf8", timeout: 100000 });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("9 subprocess worker checks passed\n");
}, 105000);

testCompose("bun-browser.wasm");
