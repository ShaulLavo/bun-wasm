import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import inputs from "./inputs.lock.json" with { type: "json" };
import { digest, verifyFiles, verifyIntegrity } from "./acquire.ts";
import { configuredManifest, packageManifest, variantVersion, object, strings } from "./config.ts";
import { assertPolicy, descriptor, verify } from "./verify.ts";
import { checkClosure, generate } from "./run.ts";

const original = { name: "oxc-parser", version: "0.94.0", napi: {
  binaryName: "parser", packageName: "@oxc-parser/binding", targets: ["x86_64-unknown-linux-gnu", "wasm32-wasip1-threads"],
  wasm: { browser: { fs: false } },
} };
const policySource = "new WebAssembly.Memory({ initial: 1024, maximum: 4096, shared: true })";

test("all addons share the attested source and original generator", () => {
  expect(inputs.source.tag).toBe("crates_v0.94.0");
  expect(inputs.source.commit).toBe("f88f5f4593b56f77460beed2178ac7b207d5364c");
  expect(inputs.generator.version).toBe("3.2.0");
  expect(inputs.addons.map(addon => addon.addon)).toEqual(["parser", "transform", "minify"]);
  for (const addon of inputs.addons) expect(addon.minimumPages).toBeLessThanOrEqual(1024);
});

test("source configuration changes only descriptor policy and honest version identity", () => {
  const configured = configuredManifest(original, true);
  expect(configured).toEqual({ ...original, version: variantVersion, napi: { ...original.napi,
    wasm: { ...original.napi.wasm, initialMemory: 1024, maximumMemory: 4096 },
  } });
  expect(original.version).toBe("0.94.0");
  expect(original.napi.wasm).toEqual({ browser: { fs: false } });
  const baseline: unknown = configuredManifest(original, false);
  expect(baseline).toEqual(original);
});

test("artifact identity preserves entry points, dependency range, native selection and full files list", () => {
  const pkg = { name: "@oxc-parser/binding-wasm32-wasi", version: "0.94.0", main: "parser.wasi.cjs", browser: "parser.wasi-browser.js",
    files: ["parser.wasi.cjs", "parser.wasi-browser.js", "wasi-worker.mjs", "wasi-worker-browser.mjs", "parser.wasm32-wasi.wasm", "browser-bundle.js"],
    dependencies: { "@napi-rs/wasm-runtime": "^1.0.6" } };
  expect(packageManifest(pkg, true)).toEqual({ ...pkg, version: variantVersion, files: pkg.files.concat(["bun-wasm-variant.json"]) });
  expect(packageManifest(pkg, false)).toEqual(pkg);
  expect(pkg.files).not.toContain("bun-wasm-variant.json");
});

test("fail before: original 4000/65536 descriptors do not satisfy maintained policy", () => {
  expect(() => assertPolicy("new WebAssembly.Memory({ initial: 4000, maximum: 65536, shared: true })")).toThrow();
  expect(() => assertPolicy("new WebAssembly.Memory({ initial: 4e3, maximum: 65536, shared: true })")).toThrow();
  expect(() => assertPolicy(policySource)).not.toThrow();
});

test("descriptor verification rejects missing, duplicate, unshared and wrong cap outputs", () => {
  expect(() => descriptor("no memory")).toThrow("Expected one");
  expect(() => descriptor(policySource + policySource)).toThrow("Expected one");
  expect(() => assertPolicy("new WebAssembly.Memory({ initial: 1024, maximum: 4096, shared: false })")).toThrow();
  expect(() => assertPolicy("new WebAssembly.Memory({ initial: 1024, maximum: 8192, shared: true })")).toThrow();
});

test("integrity rejects altered package bytes before extraction or execution", () => {
  const bytes = new TextEncoder().encode("pristine");
  const integrity = `sha512-${digest(bytes, "sha512", "base64")}`;
  expect(() => verifyIntegrity(bytes, integrity)).not.toThrow();
  expect(() => verifyIntegrity(new TextEncoder().encode("altered"), integrity)).toThrow("Integrity mismatch");
});

test("boundary parsers reject invalid source manifests and files", () => {
  for (const value of [null, [], 3, "manifest"]) expect(() => object(value)).toThrow();
  for (const value of [null, {}, [3], Array(2)]) expect(() => strings(value)).toThrow();
  expect(() => configuredManifest({ napi: {} }, true)).toThrow();
  expect(() => packageManifest({ files: [null] }, true)).toThrow();
});

test("closure requires every declared worker, bundle and Wasm file and rejects leftovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-oxc-closure-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ files: ["wasi-worker.mjs", "browser-bundle.js", "addon.wasm"] }));
    await expect(checkClosure(root)).rejects.toThrow();
    for (const file of ["wasi-worker.mjs", "browser-bundle.js", "addon.wasm"]) await writeFile(join(root, file), "fixture");
    await checkClosure(root);
    await writeFile(join(root, "unexpected.js"), "fixture");
    await expect(checkClosure(root)).rejects.toThrow("Unexpected packed inputs");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("pinned file validation fails closed on changed or missing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-oxc-input-"));
  try {
    await writeFile(join(root, "source"), "pristine");
    await verifyFiles(root, { source: digest(new TextEncoder().encode("pristine")) });
    await expect(verifyFiles(root, { source: "wrong" })).rejects.toThrow("Changed pinned input");
    await expect(verifyFiles(root, { source: undefined })).rejects.toThrow("Missing input hash");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generation never takes over or removes a pre-existing directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-oxc-owned-"));
  try {
    await writeFile(join(root, "keep"), "owner data");
    await expect(generate(root, "unused")).rejects.toThrow();
    expect(await readFile(join(root, "keep"), "utf8")).toBe("owner data");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("control cleanup does not remove a pre-existing scratch path", async () => {
  const root = await mkdtemp(join(tmpdir(), "bun-wasm-oxc-refusal-"));
  try {
    await mkdir(join(root, "scratch"));
    await writeFile(join(root, "scratch/keep"), "owner data");
    // Missing generated prerequisites fail before scratch ownership is acquired.
    await expect(verify(join(root, "missing"), "unused", join(root, "scratch"))).rejects.toThrow();
    expect(await readFile(join(root, "scratch/keep"), "utf8")).toBe("owner data");
  } finally { await rm(root, { recursive: true, force: true }); }
});
