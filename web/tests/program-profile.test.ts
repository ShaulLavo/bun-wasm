import { expect, test } from "bun:test";
import { appendCustomSection } from "../../src/engine-kind";
import { loadEngineProgram } from "../src/engine-loader";
import { parseMemoryProfile, profileAsset, requireProfileEngine, verifyMemoryProfile } from "../src/program-profile";

test("memory profile is explicit and independent of engine selection", async () => {
  expect(parseMemoryProfile(null)).toBe("split");
  expect(parseMemoryProfile("shared-group")).toBe("shared-group");
  for (const value of ["", "shared", "jsc", "quickjs", 1]) expect(() => parseMemoryProfile(value)).toThrow("Unknown Bun program memory profile");
  for (const engine of ["quickjs", "jsc", "spidermonkey"] as const) expect(() => requireProfileEngine(engine, "shared-group")).not.toThrow();
  for (const engine of ["browser"] as const) {
    await expect(loadEngineProgram(engine, "shared-group", () => {})).rejects.toThrow("unavailable");
  }
});

test("profile paths and module admission cannot alias split and shared programs", () => {
  const bytes = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const split = new WebAssembly.Module(bytes);
  const shared = new WebAssembly.Module(appendCustomSection(bytes, "dylink.0", new Uint8Array()));
  expect(profileAsset("bun.wasm", "split")).toBe("bun.wasm");
  expect(profileAsset("bun.wasm", "shared-group")).toBe("profiles/shared-group/bun.wasm");
  verifyMemoryProfile(split, "split");
  verifyMemoryProfile(shared, "shared-group");
  expect(() => verifyMemoryProfile(split, "shared-group")).toThrow("selected shared-group, received split");
  expect(() => verifyMemoryProfile(shared, "split")).toThrow("selected split, received shared-group");
});

test("both production pages validate selection before creating one runtime with Bun's policy", async () => {
  const probe = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    import { BUN_MEMORY_GROUP_POLICY } from "./src/engine-kind.ts";
    const waffle = await import("waffle");
    Object.defineProperty(globalThis, "location", { value: new URL("https://example.test/") });
    const requests = [];
    const stop = new Error("runtime boundary reached");
    for (const scope of ["web", "sandbox"]) mock.module(Bun.resolveSync("waffle", process.cwd() + "/" + scope), () => ({ ...waffle, createRuntime(options) { requests.push(options); throw stop; } }));
    const { Playground } = await import("./web/src/playground/playground.ts");
    const { Sandbox } = await import("./sandbox/src/sandbox.ts");
    console.error = error => assert.equal(error, stop);
    for (const Page of [Playground, Sandbox]) {
      for (const profile of ["split", "shared-group"]) {
        await new Page("?engine=quickjs&mode=memory&profile=" + profile).start();
      }
      assert.throws(() => new Page("?profile=shared"), Page === Playground ? /Unknown Bun program profile/ : /Unknown Bun program memory profile/);
      assert.throws(() => new Page("?engine=browser&profile=shared-group"), Page === Playground ? /does not support/ : /unavailable/);
    }
    assert.equal(requests.length, 4);
    for (const request of requests) assert.deepEqual(request.memoryGroups, BUN_MEMORY_GROUP_POLICY);
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "-e", probe], { cwd: new URL("../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
