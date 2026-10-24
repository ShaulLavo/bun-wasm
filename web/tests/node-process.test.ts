import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");

test("Node runtime_proc supports arbitrary bindings, transfer-before-close, backpressure, wait, poll and signals", () => {
  const child = spawnSync("node", ["--no-warnings", new URL("./fixtures/node-process-abi.ts", import.meta.url).pathname], { cwd: root, encoding: "utf8", timeout: 20000, input: "s".repeat(100000) });
  expect(child.stderr).toBe("");
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ bytes: 200000, stdinBytes: 100000, exit: 7, missing: 127, signal: 9, groupSignal: 15, omitted: true });
});
