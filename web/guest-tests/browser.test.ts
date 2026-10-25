import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { testCompose } from "./compose";

const root = resolve(import.meta.dir, "../..");

test("fresh Node-hosted WASM subprocesses preserve stdio, cwd, files, exits and signals", () => {
  const child = spawnSync("node", ["--no-warnings", new URL("../tests/subprocess.mjs", import.meta.url).pathname], { cwd: root, encoding: "utf8", timeout: 100000 });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("9 subprocess worker checks passed\n");
}, 105000);

testCompose("bun-browser.wasm");
