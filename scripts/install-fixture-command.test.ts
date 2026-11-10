import { expect, test } from "bun:test";
import { installFixtureTargets } from "./install-fixture-command";

test("runtime tarball checks select each existing engine artifact once", () => {
  expect(installFixtureTargets({ BUN_WASM: "/wrong-single-core.wasm" }, "/fixture")).toEqual([
    { engine: "quickjs", wasm: "/fixture/dist/bun.wasm" },
    { engine: "jsc", wasm: "/fixture/dist/bun-jsc.wasm" },
    { engine: "browser", wasm: "/fixture/dist/bun-browser.wasm" },
  ]);
});

test("explicit source controls select one engine and its program without changing the matrix default", () => {
  expect(installFixtureTargets({ INSTALL_ENGINE: "quickjs", BUN_WASM: "/source-control.wasm" }, "/fixture")).toEqual([
    { engine: "quickjs", wasm: "/source-control.wasm" },
  ]);
  expect(installFixtureTargets({ INSTALL_ENGINE: "jsc" }, "/fixture")).toEqual([
    { engine: "jsc", wasm: "/fixture/dist/bun-jsc.wasm" },
  ]);
  expect(() => installFixtureTargets({ INSTALL_ENGINE: "invalid" }, "/fixture")).toThrow("Unknown install engine");
});
