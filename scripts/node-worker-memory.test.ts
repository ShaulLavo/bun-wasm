import { expect, test } from "bun:test";
import { productApps } from "./app-matrix/product.ts";

const app = productApps.find(app => app.id === "next-15-app-static");
const source = app?.files["next.config.ts"];
if (!source) throw new Error("Missing actual Next 15 config fixture");
const probe = new URL("./node-worker-memory-probe.ts", import.meta.url).pathname;

test("Node-host workers compile real Next config with finite default and explicit heap/stack limits", () => {
  const result = Bun.spawnSync(["node", "--no-warnings", probe, "limits", source], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("node worker memory contract passed");
}, 35_000);

test("Node-host worker OOM keeps the original fatal diagnostic when the worker cannot write it", () => {
  const result = Bun.spawnSync(["bash", "-euc", 'ulimit -c 0; exec "$@"', "node-worker-oom", "node", "--no-warnings", probe, "oom", source], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toContain("ERR_WORKER_OUT_OF_MEMORY");
  expect(result.stderr.toString()).toContain("JS heap out of memory");
  expect(result.stdout.toString()).toContain("node worker memory contract passed");
}, 35_000);

for (const mode of ["sink-failure", "ordinary"]) {
  test(`Node-host ${mode} preserves later error listeners and native worker exit`, () => {
    const result = Bun.spawnSync(["node", "--no-warnings", probe, mode, source], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain("node worker memory contract passed");
  }, 35_000);
}
