import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");

async function run(command: string[], env = process.env) {
  const child = Bun.spawn(command, { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 90000 });
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, error: code ? stderr : "" }).toEqual({ code: 0, error: "" });
    return stdout;
  } finally { child.kill(); }
}

test("Node runtime_proc supports arbitrary bindings, transfer-before-close, backpressure, wait, poll and signals", () => {
  const child = spawnSync("node", ["--no-warnings", new URL("./fixtures/node-process-abi.ts", import.meta.url).pathname], { cwd: root, encoding: "utf8", timeout: 20000, input: "s".repeat(100000) });
  expect(child.stderr).toBe("");
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ bytes: 200000, stdinBytes: 100000, exit: 7, missing: 127, signal: 9, groupSignal: 15, omitted: true });
});

test.skipIf(!existsSync(process.env.BUN_WASM_TEST_BROWSER_WASM || resolve(root, "dist/bun-browser.wasm")))("fresh Node-hosted WASM subprocesses preserve stdio, cwd, files, exits and signals", () => {
  const child = spawnSync("node", ["--no-warnings", new URL("./subprocess.mjs", import.meta.url).pathname], { cwd: root, encoding: "utf8", timeout: 100000 });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("9 subprocess worker checks passed\n");
}, 105000);

for (const artifact of ["bun.wasm", "bun-jsc.wasm", "bun-browser.wasm"]) {
  test.skipIf(!existsSync(resolve(root, "dist", artifact)))(`Node runtime_proc and local registry fetch compose for ${artifact}`, async () => {
    const code = `const {Worker}=require('node:worker_threads'); const w=new Worker("require('node:worker_threads').parentPort.postMessage(42)",{eval:true}); w.on('message', value => console.log('worker', value));`;
    const output = await run(["node", "--no-warnings", "web/scripts/node-host.mjs", "--wasm", `dist/${artifact}`, "--", "-e", code]);
    expect(output).toContain("worker 42");
    const installed = await run(["node", "tests/install/run.mjs"], {
      ...process.env, INSTALL_ENGINE: "browser", BUN_WASM: `dist/${artifact}`, INSTALL_CASES: "aliases",
    });
    expect(installed).toContain("1 passed, 0 failed");
  }, 120000);
}
