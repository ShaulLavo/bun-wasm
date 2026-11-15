import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

function start(adapter: "bun" | "wasi") {
  const child = spawnSync("node", ["--no-warnings", new URL("./fixtures/node-network-boundary.ts", import.meta.url).pathname, adapter], {
    encoding: "utf8", timeout: 20000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return { ...JSON.parse(child.stdout), stderr: child.stderr };
}

test("network-enabled generic Preview1 children start without Bun host slots", () => {
  const result = start("wasi");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.outcome).toMatchObject({ kind: "exited", code: 0 });
}, 30000);

test("network-enabled Bun children still require their CLI fetch host slots", () => {
  const result = start("bun");
  expect(result.code).toBe(126);
  expect(result.stderr).toContain("Missing host slots export");
  expect(result.outcome).toMatchObject({ kind: "start-failed", error: "EIO" });
}, 30000);
