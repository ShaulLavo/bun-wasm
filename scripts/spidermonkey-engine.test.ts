import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { prepareEngineInputs, verifyEngineInputs } from "../spidermonkey/prepare-engine-inputs.ts";
import { captureInputs, convertSideInitializers, verifyPairReceipt, verifySide, writePairReceipt } from "./spidermonkey-side-core-receipt.ts";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture.ts";
import { performanceProfile } from "../spidermonkey/native-profile.ts";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const put = (path: string, value: string | Uint8Array) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
const json = (path: string, value: unknown) => put(path, JSON.stringify(value, null, 2) + "\n");

test.each([
  { name: "SPIDERMONKEY_TRANSFER_FAULT", value: "1" },
  { name: "SPIDERMONKEY_TRANSFER_FAULT", value: "" },
  { name: "SPIDERMONKEY_TRANSFER_FAULT", value: "true" },
  { name: "BUN_WASM_TRANSFER_FAULT", value: "0" },
  { name: "BUN_WASM_TRANSFER_FAULT", value: "1" },
  { name: "BUN_WASM_TRANSFER_FAULT", value: "" },
])("ordinary SM capture rejects validation $name=$value before native reads", ({ name, value }) => {
  const previous = process.env[name];
  process.env[name] = value;
  try { expect(() => captureInputs("/unused", "/unused")).toThrow("SPIDERMONKEY_TRANSFER_FAULT=0 and no BUN_WASM_TRANSFER_FAULT"); }
  finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-side-core-"));
  const source = join(root, "source");
  mkdirSync(source);
  execFileSync("git", ["init", "--quiet", source]);
  execFileSync("git", ["-C", source, "-c", "user.name=N2 control", "-c", "user.email=n2@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  const archive = join(root, "archive.a");
  const profile = join(root, "native-profile.json");
  const headers = join(root, "headers.json");
  const include = join(root, "include");
  const confdefs = join(root, "js-confdefs.h");
  put(archive, "admitted archive bytes");
  put(profile, "{\"profile\":\"split\"}\n");
  put(confdefs, "#define JS_CODEGEN_NONE 1\n");
  put(join(include, "jsapi.h"), "header bytes");
  const manifest = [{ path: "jsapi.h", sha256: hash("header bytes") }];
  json(headers, manifest);
  const qualification = join(root, "QUALIFICATION.json");
  json(qualification, { status: "VERIFIED_ARTIFACT_ONLY" });
  const admission = join(root, "PARENT-NATIVE-BYTE-ADMISSION.json");
  json(admission, { status: "ADMITTED_FOR_CONTROLLED_N2_INPUTS", admitted: true,
    archive: { path: archive, bytes: readFileSync(archive).byteLength, sha256: hash(readFileSync(archive)) },
    headers: { includeRoot: include, manifest: headers, manifestSha256: hash(readFileSync(headers)), count: 1, confdefs, confdefsSha256: hash(readFileSync(confdefs)) },
    profile: { path: profile, sha256: hash(readFileSync(profile)) }, qualification: { path: qualification, sha256: hash(readFileSync(qualification)) },
    originalAttempt: { status: "FAILED", successfulNativeReceiptExists: false }, originalBuildToolchain: { originalCompilerProvenanceClaimed: false, identities: null },
    compiledSource: { head: "1a53e2123e4876be671a9a03eb025ae569795001", tree: "c494195936b4b23bfc8bef9fdcb624e513fa82e4" } });
  return { root, source, admission, native: join(root, "native"), archive, profile, headers, confdefs, include };
}

test("staging consumes only parent-admitted bytes and never emits a G2 receipt", () => {
  const f = fixture();
  try {
    prepareEngineInputs(f.admission, f.native);
    verifyEngineInputs(f.native);
    const receipt = JSON.parse(readFileSync(join(f.native, "native-inputs.json"), "utf8"));
    expect(receipt.status).toBe("ADMITTED_FOR_CONTROLLED_N2_INPUTS");
    expect(receipt.archive.path).toBe("libspidermonkey_bunwasm.a");
    expect(receipt).not.toHaveProperty("g1ReceiptSha256");
    expect(receipt).not.toHaveProperty("g2ReceiptSha256");
    expect(hash(readFileSync(join(f.native, "libspidermonkey_bunwasm.a")))).toBe(hash(readFileSync(f.archive)));
    expect(readFileSync(join(f.native, "include/jsapi.h"), "utf8")).toBe("header bytes");
    expect(() => prepareEngineInputs(f.admission, f.native)).not.toThrow();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("unadmitted N1 evidence is rejected before staging", () => {
  const f = fixture();
  try {
    const admission = JSON.parse(readFileSync(f.admission, "utf8"));
    admission.admitted = false;
    json(f.admission, admission);
    expect(() => prepareEngineInputs(f.admission, f.native)).toThrow(/admission/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("experimental pair validation and receipt bind both artifacts to one source and native input", () => {
  const f = fixture();
  const pair = quickjsPair("spidermonkey");
  try {
    prepareEngineInputs(f.admission, f.native);
    const inputs = captureInputs(f.source, f.native);
    verifySide(pair.side, pair.core, inputs);
    const core = join(f.root, "core.wasm"), side = join(f.root, "side.wasm"), receipt = join(f.root, "pair.json");
    put(core, pair.core); put(side, pair.side);
    const result = writePairReceipt(core, side, inputs, receipt);
    expect(result.experimental).toBe(true);
    expect(result.scope).toBe("spidermonkey-side-core");
    expect(JSON.parse(readFileSync(receipt, "utf8")).native.receiptSha256).toBe(hash(readFileSync(join(f.native, "native-inputs.json"))));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("SpiderMonkey build scripts stay outside normal engine/core/initializer receipts", () => {
  for (const recipe of ["build-engine-spidermonkey.sh", "build-bun-spidermonkey.sh"]) {
    const text = readFileSync(resolve("scripts", recipe), "utf8");
    expect(text).not.toContain("guest-engine-receipt.ts");
    expect(text).not.toContain("guest-core-receipt.ts");
    expect(text).not.toContain("engine-explicit-init.ts");
    expect(text).toContain("spidermonkey-side-core-receipt.ts");
  }
});


test("staging retains original failure and rejects edited provenance or bytes", () => {
  const f = fixture();
  try {
    prepareEngineInputs(f.admission, f.native);
    const path = join(f.native, "native-inputs.json");
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    expect(receipt.originalAttempt.status).toBe("FAILED");
    expect(receipt.originalBuildToolchain.originalCompilerProvenanceClaimed).toBe(false);
    expect(receipt.admissionSha256).toBe(hash(readFileSync(f.admission)));
    receipt.originalAttempt.status = "PASSED";
    json(path, receipt);
    expect(() => verifyEngineInputs(f.native)).toThrow(/provenance/);
    expect(() => prepareEngineInputs(f.admission, f.native)).toThrow(/relabeled/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("header paths cannot escape the staged include directory", () => {
  const f = fixture();
  try {
    json(f.headers, [{ path: "/tmp/escaped.h", sha256: hash("header bytes") }]);
    const admission = JSON.parse(readFileSync(f.admission, "utf8"));
    admission.headers.manifestSha256 = hash(readFileSync(f.headers));
    json(f.admission, admission);
    expect(() => prepareEngineInputs(f.admission, f.native)).toThrow(/header path/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("pair replay rejects malformed identities and changed artifact bytes", () => {
  const f = fixture();
  const pair = quickjsPair("spidermonkey");
  try {
    prepareEngineInputs(f.admission, f.native);
    const inputs = captureInputs(f.source, f.native);
    const core = join(f.root, "core.wasm"), side = join(f.root, "side.wasm"), path = join(f.root, "pair.json");
    put(core, pair.core); put(side, pair.side);
    writePairReceipt(core, side, inputs, path);
    expect(verifyPairReceipt(core, side, path, inputs).experimental).toBe(true);
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    receipt.source.head = "invalid";
    json(path, receipt);
    expect(() => verifyPairReceipt(core, side, path, inputs)).toThrow(/source identity/);
    put(join(f.source, "changed"), "untracked");
    expect(() => captureInputs(f.source, f.native)).toThrow(/clean/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

function implicitSide(shared = false) {
  const u32 = (value: number): number[] => {
    const bytes: number[] = [];
    do { const next = value >>> 7; bytes.push((value & 127) | (next ? 128 : 0)); value = next; } while (value);
    return bytes;
  };
  const name = (text: string) => u32(text.length).concat(Array.from(new TextEncoder().encode(text)));
  const section = (id: number, payload: number[]) => [id].concat(u32(payload.length), payload);
  const imported = (label: string, descriptor: number[]) => name("env").concat(name(label), descriptor);
  const exported = (label: string, index: number) => name(label).concat([0], u32(index));
  const imports = [imported("core_checkpoint", [0, 0]), imported("memory", shared ? [2, 3, 1].concat(u32(32768)) : [2, 0, 1]),
    imported("__indirect_function_table", [1, 0x70, 0, 1]), imported("__stack_pointer", [3, 0x7f, 1])];
  const exports = [exported("__wasm_apply_data_relocs", 1), exported("__wasm_call_ctors", 2),
    exported("spidermonkey_register", 3), exported("spidermonkey_run", 4)]
    .concat(Array.from({ length: 125 }, (_, i) => exported(`extra_${i}`, 4)));
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(0, name("dylink.0").concat([1, 4, 0, 0, 0, 0])), section(1, [1, 0x60, 0, 0]),
    section(2, u32(imports.length).concat(imports.flat())), section(3, [4, 0, 0, 0, 0]),
    section(7, u32(exports.length).concat(exports.flat())), section(8, [1]), section(10, [4].concat(Array.from({ length: 4 }, () => [2, 0, 0x0b]).flat()))));
}

test("initializer conversion uses global indices, preserves imports, and encodes large export vectors", () => {
  const input = implicitSide();
  const converted = convertSideInitializers(input);
  const module = new WebAssembly.Module(converted);
  expect(WebAssembly.Module.imports(module)).toEqual(WebAssembly.Module.imports(new WebAssembly.Module(input)));
  expect(WebAssembly.Module.exports(module)).toContainEqual({ name: "__stack_pointer", kind: "global" });
  expect(WebAssembly.Module.exports(module).length).toBe(132);
  expect(() => convertSideInitializers(converted)).toThrow();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const stack = new WebAssembly.Global({ value: "i32", mutable: true }, 32768);
  const instance = new WebAssembly.Instance(module, { env: { memory, __stack_pointer: stack,
    __indirect_function_table: new WebAssembly.Table({ element: "anyfunc", initial: 1 }), core_checkpoint() {} } });
  expect(instance.exports.__stack_pointer).toBe(stack);
});


test("the experimental initializer CLI accepts the retained C2 converter inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "bun-wasm-sm-c2-cli-"));
  try {
    for (const name of ["base", "probe"]) {
      const input = join(root, `${name}.implicit.wasm`);
      const output = join(root, `${name}.wasm`);
      writeFileSync(input, implicitSide());
      execFileSync("node", ["scripts/spidermonkey-side-core-receipt.ts", "convert-side", input, output]);
      expect(WebAssembly.validate(readFileSync(output))).toBe(true);
      expect(WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(output))))
        .toContainEqual({ name: "spidermonkey_initialize_memory", kind: "function" });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function customSection(label: string, payload: number[]): number[] {
  const bytes = Array.from(new TextEncoder().encode(label));
  const contents = [bytes.length].concat(bytes, payload);
  expect(contents.length).toBeLessThan(128);
  return [0, contents.length].concat(contents);
}

for (const profile of ["split", "shared-group"] as const) test(`debug filtering preserves executable and custom bytes for ${profile}`, () => {
  const original = implicitSide(profile === "shared-group");
  const kept = ["name", "bun-wasm-engine", "target_features", "bun-wasm-profile", "unknown-section"];
  const sections = kept.concat([".debug_info", ".debug_line", ".debug_abbrev"]).map(label => customSection(label, [0]));
  const input = Uint8Array.from(Array.from(original).concat(...sections));
  const converted = convertSideInitializers(input, profile);
  const expected = Uint8Array.from(Array.from(convertSideInitializers(original, profile)).concat(...kept.map(label => customSection(label, [0]))));
  expect(converted).toEqual(expected);
  const module = new WebAssembly.Module(converted);
  for (const label of kept) expect(new Uint8Array(WebAssembly.Module.customSections(module, label)[0]!)).toEqual(Uint8Array.of(0));
  expect(WebAssembly.Module.customSections(module, "dylink.0")).toHaveLength(1);
  for (const label of [".debug_info", ".debug_line", ".debug_abbrev"]) expect(WebAssembly.Module.customSections(module, label)).toHaveLength(0);
});

test("current admission requires successful source-bound qualification and effective macros", () => {
  const f = fixture();
  try {
    const admissionPath = join(f.root, "PARENT-NATIVE-BYTE-ADMISSION.json");
    const admission = JSON.parse(readFileSync(admissionPath, "utf8"));
    const macros = { JS_CRASH_DIAGNOSTICS: null, DEBUG: null, MOZ_DIAGNOSTIC_ASSERT_ENABLED: "1", BUNWASM_EMBED: "1", __wasi__: "1",
      NIGHTLY_BUILD: "1", MOZ_RELEASE_ASSERT: "(...)", MOZ_CRASH: "(...)" };
    const release = { macros };
    const debug = { macros: { ...macros, JS_CRASH_DIAGNOSTICS: "1", DEBUG: "1" } };
    const qualification = { gate: "N1", source: { commit: admission.compiledSource.head, tree: admission.compiledSource.tree },
      profile: { performance: performanceProfile }, diagnostics: { profile: performanceProfile, library: release, embedding: release, debugLibrary: debug, debugEmbedding: debug },
      sha256: admission.archive.sha256, bytes: admission.archive.bytes, confdefsSha256: admission.headers.confdefsSha256,
      headers: { sha256: admission.headers.manifestSha256, count: admission.headers.count } };
    delete admission.originalAttempt;
    delete admission.originalBuildToolchain;
    admission.status = "ADMITTED_CURRENT_NATIVE_GENERATION";
    json(admission.qualification.path, qualification);
    admission.qualification.sha256 = hash(readFileSync(admission.qualification.path));
    json(admissionPath, admission);
    prepareEngineInputs(admissionPath, f.native);
    verifyEngineInputs(f.native);
    expect(JSON.parse(readFileSync(join(f.native, "native-inputs.json"), "utf8")).schema).toBe(3);
    json(admission.qualification.path, { ...qualification, diagnostics: { ...qualification.diagnostics,
      embedding: { macros: { ...macros, JS_CRASH_DIAGNOSTICS: "1" } } } });
    admission.qualification.sha256 = hash(readFileSync(admission.qualification.path));
    json(admissionPath, admission);
    expect(() => prepareEngineInputs(admissionPath, join(f.root, "bad-current"))).toThrow();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
