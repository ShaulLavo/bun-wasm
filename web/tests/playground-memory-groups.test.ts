import { expect, test } from "bun:test";

test("playground boot admits Bun group cores with their declared memory and stack limits", async () => {
  // Isolate module mocks and the editor's background timers from the other Web tests.
  const probe = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    const waffle = await import("waffle");
    const requests: Parameters<typeof waffle.createRuntime>[0][] = [];
    const stop = new Error("runtime boundary reached");
    mock.module("waffle", () => ({ ...waffle, createRuntime(options) {
      requests.push(options);
      throw stop;
    } }));
    const { Playground } = await import("./src/playground/playground.ts");
    console.error = error => { assert.equal(error, stop); };
    for (const engine of ["quickjs", "jsc", "browser"]) {
      await new Playground("?engine=" + engine + "&template=nuxt&mode=memory").start();
    }
    assert.equal(requests.length, 3);
    for (const options of requests) {
      assert.deepEqual(options.memoryGroups, { maximumPages: 32768, memberPages: 16384, stackBytes: 8 << 20 });
      assert.deepEqual(options.filesystem, { mode: "memory", name: "bun-wasm-workspace-nuxt" });
    }
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "-e", probe], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe", timeout: 10_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
