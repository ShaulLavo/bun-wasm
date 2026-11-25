import { expect, spyOn, test } from "bun:test";
import type { RuntimeOptions } from "waffle";
import { appendCustomSection, BUN_MEMORY_GROUP_POLICY } from "../../src/engine-kind";
import { engineUnavailable, loadEngineProgram } from "../src/engine-loader";
import { parseMemoryProfile, profileAsset, requireProfileEngine, verifyMemoryProfile } from "../src/program-profile";
import { models, turn } from "./ui-model-helpers";

async function startProfiles(Page: new (search: string) => { start(): void | Promise<void> }): Promise<void> {
  for (const profile of ["split", "shared-group"]) {
    const instance = new Page(`?engine=quickjs&profile=${profile}`);
    await instance.start();
    await turn();
  }
}

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
  const page = await models();
  const requests: RuntimeOptions[] = [];
  const stop = new Error("runtime boundary reached");
  page.boundary.onCreateRuntime = (options?: RuntimeOptions) => {
    if (options) requests.push(options);
    throw stop;
  };
  const errors = spyOn(console, "error").mockImplementation((error: unknown) => {
    expect(error).toBe(stop);
  });
  try {
    for (const Page of [page.Playground, page.Sandbox]) {
      await startProfiles(Page);
      expect(() => new Page("?profile=shared")).toThrow(
        Page === page.Playground ? /Unknown Bun program profile/ : /Unknown Bun program memory profile/,
      );
      expect(() => new Page("?engine=browser&profile=shared-group")).toThrow(/does not support/);
    }
    expect(requests).toHaveLength(4);
    for (const request of requests) expect(request.memoryGroups).toEqual(BUN_MEMORY_GROUP_POLICY);
  } finally {
    errors.mockRestore();
    await page.cleanup();
  }
});

for (const engine of ["quickjs", "jsc", "spidermonkey"] as const) test(`${engine} missing shared assets fail before a fetch or split substitution`, async () => {
  expect(engineUnavailable(engine, "shared-group")).toContain(`SHARED_${engine.toUpperCase()}_PROGRAM`);
  await expect(loadEngineProgram(engine, "shared-group", () => { throw new Error("Must not fetch"); })).rejects.toThrow("shared-group is not in this build");
});
