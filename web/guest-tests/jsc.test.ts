import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { testCompose } from "./compose";

testCompose("bun-jsc.wasm");

test("JSC required ES namespaces preserve module markers and live bindings", () => {
  const root = resolve(import.meta.dir, "../..");
  const fixture = resolve(root, "tests/fixtures/require-esm-namespace-marker");
  const child = spawnSync("node", ["--no-warnings", resolve(root, "web/scripts/node-host.mjs"),
    "--wasm", resolve(root, "dist/bun-jsc.wasm"), "--dir", `${fixture}::/`,
    "--env", "PWD=/", "--env", "HOME=/", "--", "run", "/index.ts"],
  { cwd: root, encoding: "utf8", timeout: 30000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stderr).toBe("");
  expect(child.stdout).toBe(readFileSync(resolve(fixture, "expected.txt"), "utf8"));
}, 35000);
