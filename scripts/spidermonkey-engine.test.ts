import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareEngineInputs, verifyEngineInputs } from "../spidermonkey/prepare-engine-inputs.ts";
import { programKind, programKindForBuild, programProfile, verifyProgramSide } from "../src/engine-kind.ts";
import { engineEnvironment } from "./guest-core-receipt.ts";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture.ts";

const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const json = (path: string, value: unknown) => put(path, JSON.stringify(value));

function inputs() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-engine-"));
  const g1 = join(root, "g1"), g2 = join(root, "g2"), out = join(root, "g3");
  const headers = [{ path: "jsapi.h", sha256: hash("header") }];
  const receipt = { gate: "G1", revision: "a5df22d986d4b626f771b4f8885241941601c35c", configureStatusSha256: hash("config"),
    compileCommandsSha256: hash("commands"), cargoManifestSha256: hash("manifest"), confdefsSha256: hash("confdefs"),
    mozconfigSha256: hash("mozconfig"), headers: { count: 1, sha256: hash(JSON.stringify(headers)) } };
  put(join(g1, "libspidermonkey_bunwasm.a"), "original archive");
  json(join(g1, "receipt/vm-library.json"), receipt);
  json(join(g1, "receipt/headers.json"), headers);
  const files: readonly (readonly [string, string])[] = [["obj/config.status", "config"], ["obj/clangd/compile_commands.json", "commands"],
    ["firefox/Cargo.toml", "manifest"], ["obj/js/src/js-confdefs.h", "confdefs"], ["mozconfig", "mozconfig"],
    ["obj/dist/include/jsapi.h", "header"]];
  for (const [file, text] of files) put(join(g1, file), text);
  put(join(g2, "libspidermonkey_g2.a"), "G2 archive");
  put(join(g2, "compile-commands.json"), "G2 commands");
  json(join(g2, "native.json"), { gate: "G2", baselineReceiptSha256: hash(JSON.stringify(receipt)),
    baselineLibrarySha256: hash("original archive"), librarySha256: hash("G2 archive"), compileCommandsSha256: hash("G2 commands"),
    patchSha256: hash(readFileSync(resolve("spidermonkey/spidermonkey-wasi.patch"))) });
  return { root, g1, g2, out };
}

test("SpiderMonkey uses its own split-only tag and initializer profile", () => {
  const pair = quickjsPair("spidermonkey");
  expect(programKind(new WebAssembly.Module(pair.core))).toBe("spidermonkey");
  expect(programKindForBuild("spidermonkey")).toBe("spidermonkey");
  expect(programProfile("spidermonkey").initialize).toEqual([
    "spidermonkey_initialize_memory", "spidermonkey_apply_data_relocs", "spidermonkey_call_ctors", "spidermonkey_register",
  ]);
  verifyProgramSide("spidermonkey", new WebAssembly.Module(pair.side));
  expect(() => verifyProgramSide("spidermonkey", new WebAssembly.Module(quickjsPair("jsc").side))).toThrow(/companion/);
  expect(() => engineEnvironment("spidermonkey", "/sysroot", "shared-group")).toThrow(/not qualified/);
  expect(engineEnvironment("spidermonkey", "/sysroot").CXXFLAGS_wasm32_wasip1).toBe("--sysroot=/sysroot -fPIC -fno-exceptions");
});

test("G3 copies verified G1 and G2 inputs without relabeling the native build", () => {
  const fixture = inputs();
  try {
    prepareEngineInputs(fixture.g1, fixture.g2, fixture.out);
    const receipt = readFileSync(join(fixture.out, "native-inputs.json"), "utf8");
    expect(JSON.parse(receipt).origin).toBe("reused G2 native inputs, not a new Mozilla build");
    prepareEngineInputs(fixture.g1, fixture.g2, fixture.out);
    expect(readFileSync(join(fixture.out, "native-inputs.json"), "utf8")).toBe(receipt);
    expect(readFileSync(join(fixture.g1, "libspidermonkey_bunwasm.a"), "utf8")).toBe("original archive");
    verifyEngineInputs(fixture.out);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

for (const path of ["include/jsapi.h", "libspidermonkey_g2.a", "compile-commands.json", "js-confdefs.h", "g1-receipt.json", "g2-receipt.json"]) {
  test(`G3 rejects native-input drift in ${path}`, () => {
    const fixture = inputs();
    try {
      prepareEngineInputs(fixture.g1, fixture.g2, fixture.out);
      put(join(fixture.out, path), "changed");
      expect(() => verifyEngineInputs(fixture.out)).toThrow();
      expect(() => prepareEngineInputs(fixture.g1, fixture.g2, fixture.out)).toThrow();
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
}

for (const recipe of ["build-engine-spidermonkey.sh", "build-bun-spidermonkey.sh"]) {
  test(`${recipe} stops when tool environment capture fails`, () => {
    const fixture = inputs();
    try {
      prepareEngineInputs(fixture.g1, fixture.g2, fixture.out);
      const bin = join(fixture.root, "bin");
      put(join(bin, "bun"), "#!/bin/sh\nexit 7\n");
      const chmod = Bun.spawnSync(["chmod", "+x", join(bin, "bun")]);
      expect(chmod.exitCode).toBe(0);
      const result = Bun.spawnSync(["bash", resolve("scripts", recipe)], { env: { ...process.env, PATH: bin + ":" + process.env.PATH,
        SPIDERMONKEY_NATIVE_DIR: fixture.out, SPIDERMONKEY_ENGINE_BUILD_DIR: join(fixture.root, "engine"), BUN_CORE_BUILD_DIR: join(fixture.root, "core") } });
      expect(result.exitCode).toBe(7);
    } finally { rmSync(fixture.root, { recursive: true, force: true }); }
  });
}
