import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareFreshEngineInputs, verifyEngineInputs } from "../spidermonkey/prepare-engine-inputs.ts";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function put(path: string, bytes: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }
function json(path: string, value: unknown) { put(path, JSON.stringify(value, null, 2) + "\n"); }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-fresh-"));
  roots.push(root);
  const build = join(root, "build");
  const target = join(root, "native");
  const archive = "fresh synthetic archive";
  const header = "synthetic exported header";
  const confdefs = "#define JS_CODEGEN_NONE 1\n";
  const headers = [{ path: "jsapi.h", sha256: hash(header) }];
  const profile = { profile: { jit: false, sharedMemory: false, intlApi: false } };
  put(join(build, "libspidermonkey_bunwasm.a"), archive);
  put(join(build, "obj/dist/include/jsapi.h"), header);
  put(join(build, "obj/js/src/js-confdefs.h"), confdefs);
  json(join(build, "receipt/headers.json"), headers);
  json(join(build, "receipt/native-profile.json"), profile);
  const receipt = { gate: "N1", revision: "a5df22d986d4b626f771b4f8885241941601c35c", target: "wasm32-unknown-wasip1",
    sha256: hash(archive), bytes: archive.length, headers: { count: 1, sha256: hash(readFileSync(join(build, "receipt/headers.json"))) },
    confdefsSha256: hash(confdefs), configureStatusSha256: hash("config.status"), mozconfigSha256: hash("mozconfig"), ...profile,
    source: { commit: "a".repeat(40), tree: "b".repeat(40) }, recipeInputs: [{ path: "build.sh", sha256: hash("recipe") }], toolchain: [{ path: "/compiler", sha256: hash("compiler") }],
    exceptionTagSections: 0, exceptionTagImports: 0, nonPicCodeRelocations: 0, absoluteLibcStateRelocations: 0, rustStaticlibIncluded: false };
  json(join(build, "receipt/vm-library.json"), receipt);
  return { root, build, target, receipt };
}

test("fresh origin normalizes actual library, headers and profile without inventing admission", () => {
  const f = fixture();
  prepareFreshEngineInputs(f.build, f.target);
  prepareFreshEngineInputs(f.build, f.target);
  const receipt = JSON.parse(readFileSync(join(f.target, "native-inputs.json"), "utf8"));
  expect(receipt.status).toBe("BUILT_FROM_RECIPE");
  expect(receipt.origin.kind).toBe("fresh-library");
  expect(receipt.archive.sha256).toBe(f.receipt.sha256);
  expect(receipt).not.toHaveProperty("parentAdmission");
  expect(receipt).not.toHaveProperty("admissionSha256");
  const moved = join(f.root, "relocated-native");
  renameSync(f.target, moved);
  rmSync(f.build, { recursive: true });
  expect(() => verifyEngineInputs(moved)).not.toThrow();
});

test.each(["libspidermonkey_bunwasm.a", "include/jsapi.h", "js-confdefs.h", "headers.json", "native-profile.json", "fresh-library.json"])("fresh verification rejects changed %s", path => {
  const f = fixture();
  prepareFreshEngineInputs(f.build, f.target);
  put(join(f.target, path), "changed");
  expect(() => verifyEngineInputs(f.target)).toThrow();
});

test("fresh native inputs cannot be relabeled as a parent admission", () => {
  const f = fixture();
  prepareFreshEngineInputs(f.build, f.target);
  const path = join(f.target, "native-inputs.json");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  json(path, { ...receipt, parentAdmission: true, status: "ADMITTED_FOR_CONTROLLED_N2_INPUTS" });
  expect(() => verifyEngineInputs(f.target)).toThrow(/provenance/);
  expect(() => prepareFreshEngineInputs(f.build, f.target)).toThrow(/relabeled/);
});

test("fresh staging rejects shared, JIT and exception-bearing receipts", () => {
  const f = fixture();
  for (const changed of [{ profile: { ...f.receipt.profile, sharedMemory: true } }, { profile: { ...f.receipt.profile, jit: true } }, { exceptionTagSections: 1 }]) {
    json(join(f.build, "receipt/vm-library.json"), { ...f.receipt, ...changed });
    const target = join(f.root, `rejected-${Object.keys(changed).join()}`, hash(JSON.stringify(changed)));
    expect(() => prepareFreshEngineInputs(f.build, target)).toThrow();
  }
});
