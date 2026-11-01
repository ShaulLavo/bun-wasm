import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CargoTlsMessages, inspectCryptoOutput, recordCargo } from "./tls-probe-cargo.ts";
import { sealTlsHandoff, verifyTlsHandoff } from "./tls-probe-handoff.ts";
import { fileIdentity, treeIdentity } from "./tls-probe-inputs.ts";
import { tlsFixture, fixtureCrypto, fixtureHandoff, fixtureMessages, syntheticArchive, syntheticObject } from "./tls-probe-fixture.ts";
import { discoverChecks, selectChecks } from "./test-checks.ts";

for (const abi of ["host", "wasm32-wasip1"] as const) test(`source fixture records exact ${abi} archives from streamed cached Cargo events`, async () => {
  const f = await tlsFixture();
  try {
    const build = await fixtureCrypto(f.context, abi);
    const directory = join(f.context.target, "tls-probe/cargo");
    const args = ["cargo", abi === "host" ? "test" : "clippy", "--locked"].concat(abi === "host" ? [] : ["--target", abi]);
    await recordCargo(args, abi, { ...process.env, GITHUB_WORKSPACE: f.context.workspace, BUNWASM_TLS_CARGO_RECORD_DIR: directory, FIXTURE_MESSAGES: fixtureMessages(build) }, async () => f.context);
    const record: unknown = JSON.parse(readFileSync(join(directory, `${abi}.json`), "utf8"));
    expect(record).toMatchObject({ context: f.context, output: { abi, build } });
  } finally { f.remove(); }
});

for (const mode of ["failed", "interrupted", "missing", "stale", "conflicting", "malformed"] as const) test(`Cargo ${mode} output cannot retain a success record`, async () => {
  const f = await tlsFixture();
  try {
    const build = await fixtureCrypto(f.context, "host");
    const directory = join(f.context.target, "tls-probe/cargo");
    const path = join(directory, "host.json");
    const { fixturePut } = await import("./tls-probe-fixture.ts");
    fixturePut(path, "old success must be removed");
    let messages = fixtureMessages(build);
    if (mode === "missing") messages = '{"reason":"build-finished","success":true}\n';
    if (mode === "malformed") messages = '{broken JSON\n' + messages;
    if (mode === "conflicting") messages = fixtureMessages({ ...build, outDir: join(f.root, "foreign") }).replace(/.*build-finished.*\n/, "") + messages;
    let captures = 0;
    const capture = async () => ++captures === 2 && mode === "stale" ? { ...f.context, upstream: "9".repeat(64) } : f.context;
    const env = { ...process.env, GITHUB_WORKSPACE: f.context.workspace, BUNWASM_TLS_CARGO_RECORD_DIR: directory, FIXTURE_MESSAGES: messages, FIXTURE_EXIT: mode === "failed" ? "7" : "0", FIXTURE_SIGNAL: mode === "interrupted" ? "yes" : "" };
    await expect(recordCargo(["cargo", "test", "--locked"], "host", env, capture)).rejects.toThrow();
    expect(await Bun.file(path).exists()).toBe(false);
  } finally { f.remove(); }
});

test("Cargo chunks preserve rendered diagnostics and reject incomplete records", () => {
  let rendered = "";
  const parser = new CargoTlsMessages("path+file:///missing#", text => { rendered += text; });
  const data = Buffer.from('{"reason":"compiler-message","message":{"rendered":"λ warning\\n"}}\n');
  for (const byte of data) parser.feed(Buffer.from([byte]));
  expect(rendered).toBe("λ warning\n");
  expect(() => parser.end()).toThrow("exact crypto");
});

test("host and WASI object ABIs cannot stand in for each other", async () => {
  const f = await tlsFixture();
  try {
    const build = await fixtureCrypto(f.context, "wasm32-wasip1");
    writeFileSync(join(build.outDir, "boringssl/libssl.a"), syntheticArchive(syntheticObject("host")));
    await expect(inspectCryptoOutput(f.context, "wasm32-wasip1", build)).rejects.toThrow("not WASM");
    writeFileSync(join(build.outDir, "boringssl/libssl.a"), Buffer.from("!<arch>\n"));
    await expect(inspectCryptoOutput(f.context, "wasm32-wasip1", build)).rejects.toThrow("no objects");
  } finally { f.remove(); }
});

for (const field of ["upstream", "repository", "sysrootInputs", "sdkInputs", "head", "attempt", "hostTools", "profile", "rustToolchain"] as const) test(`trusted handoff rejects changed ${field}`, async () => {
  const f = await tlsFixture();
  try {
    const handoff = await fixtureHandoff(f.context);
    await expect(verifyTlsHandoff(handoff.root, handoff.sha256, { ...f.context, [field]: "changed" })).rejects.toThrow("context mismatch");
  } finally { f.remove(); }
});

for (const file of ["output/tls.map", "output/symbols.json", "output/commands.jsonl", "output/source-proof.json", "output/compiled-hashes.json", "output/tls-probe.wasm", "cargo/host.json"] as const) test(`handoff rejects changed or missing ${file}`, async () => {
  const f = await tlsFixture();
  try {
    const handoff = await fixtureHandoff(f.context);
    writeFileSync(join(handoff.root, file), "untrusted change");
    await expect(verifyTlsHandoff(handoff.root, handoff.sha256, f.context)).rejects.toThrow();
    rmSync(join(handoff.root, file));
    await expect(verifyTlsHandoff(handoff.root, handoff.sha256, f.context)).rejects.toThrow();
  } finally { f.remove(); }
});

test("producer output digest, not self-asserted report fields, authenticates all proof bytes", async () => {
  const f = await tlsFixture();
  try {
    const handoff = await fixtureHandoff(f.context);
    expect(handoff.commands.filter(path => path === f.context.tools.cxx?.path)).toHaveLength(2);
    expect(handoff.commands.filter(path => path === f.context.tools.hostCxx?.path)).toHaveLength(1);
    expect(handoff.commands).not.toContain(f.context.tools.cargo!.executable);
    expect(handoff.commands).not.toContain("cmake");
    expect(handoff.jobOutput).toBe(`tls-sha256=${handoff.sha256}\n`);
    await expect(verifyTlsHandoff(handoff.root, handoff.sha256, f.context)).resolves.toBe(join(handoff.root, "output/tls-probe.wasm"));
    await expect(verifyTlsHandoff(handoff.root, "", f.context)).rejects.toThrow("producer output");
    await expect(verifyTlsHandoff(handoff.root, "0".repeat(64), f.context)).rejects.toThrow("digest mismatch");
    writeFileSync(f.context.tools.cxx!.path, "changed compiler bytes");
    const tools = { ...f.context.tools, cxx: { ...await fileIdentity(f.context.tools.cxx!.path), executable: f.context.tools.cxx!.executable } };
    await expect(verifyTlsHandoff(handoff.root, handoff.sha256, { ...f.context, tools })).rejects.toThrow("context mismatch");
  } finally { f.remove(); }
});

test("successful links retain their hashes even if the first size inspection fails", async () => {
  const f = await tlsFixture();
  try {
    await expect(fixtureHandoff(f.context, true)).rejects.toThrow("strip failure");
    const root = join(f.context.target, "tls-probe");
    const hashes: unknown = JSON.parse(readFileSync(join(root, "output/compiled-hashes.json"), "utf8"));
    expect(Array.isArray(hashes) && hashes.length).toBe(3);
    expect(await Bun.file(join(root, "handoff.json")).exists()).toBe(false);
  } finally { f.remove(); }
});

test("live owner is discovered once after producers and checkpoint verification", () => {
  const checks = discoverChecks();
  expect(selectChecks("cmake", checks)).toContain("scripts/tls-probe.test.ts");
  expect(selectChecks("cmake", checks)).not.toContain("scripts/tls-probe-live.test.ts");
  expect(selectChecks("native-probe", checks)).toEqual(["scripts/tls-probe-live.test.ts"]);
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const native = workflow.split("\n  native-quality:\n")[1]!.split("\n  rust:\n")[0]!;
  const rust = workflow.split("\n  rust:\n")[1]!.split("\n  package:\n")[0]!;
  expect(native.indexOf("bun scripts/tls-probe-ci.ts prepare")).toBeLessThan(native.indexOf("bun scripts/quality-rust.ts --checks-only"));
  expect(native.indexOf("bun run quality:wasi")).toBeLessThan(native.indexOf("bun scripts/tls-probe-ci.ts link"));
  expect(native.indexOf("bun scripts/tls-probe-ci.ts link")).toBeLessThan(native.indexOf("bun scripts/ci-native-handoff.ts pack"));
  expect(rust.indexOf("bun scripts/ci-native-handoff.ts unpack")).toBeLessThan(rust.indexOf("bun scripts/test-checks.ts native-probe"));
  expect(workflow.match(/bun scripts\/test-checks\.ts native-probe\n/g)).toHaveLength(1);
  expect(rust).toContain("BUNWASM_TLS_PROBE_SHA256: ${{ needs.native-quality.outputs.tls-sha256 }}");
  expect(native).not.toContain("test-checks.ts native-probe");
});


for (const provenance of [null, { fullDirectoryMatchesPinnedArchive: true }, { pin: "bad", sourceInputs: "f".repeat(64), url: "untrusted", archiveSha256: "x" }]) test("malformed provenance is rejected even within a synthetic producer envelope", async () => {
  const f = await tlsFixture();
  try {
    const handoff = await fixtureHandoff(f.context);
    writeFileSync(join(handoff.root, "output/source-proof.json"), JSON.stringify(provenance));
    await expect(sealTlsHandoff(handoff.root, f.context)).rejects.toThrow();
    await expect(verifyTlsHandoff(handoff.root, handoff.sha256, f.context)).rejects.toThrow();
  } finally { f.remove(); }
});

test("Cargo test JSON after compilation remains visible", () => {
  let rendered = "";
  const parser = new CargoTlsMessages("missing", text => { rendered += text; });
  parser.feed(Buffer.from('{"reason":"build-finished","success":true}\n{"testOutput":true}\n'));
  expect(rendered).toBe('{"testOutput":true}\n');
  expect(() => parser.end()).toThrow("exact crypto");
});


for (const change of ["source", "compiler", "sysroot", "flags", "profile", "metadata"]) test(`producer rejects changed CMake ${change}`, async () => {
  const f = await tlsFixture();
  try {
    const build = await fixtureCrypto(f.context, "wasm32-wasip1");
    const directory = join(build.outDir, "boringssl");
    const cache = join(directory, "CMakeCache.txt");
    if (change === "profile") writeFileSync(join(directory, "bunwasm-program-profile"), "shared-group");
    if (change === "metadata") rmSync(join(directory, "CMakeFiles/4.4.4/CMakeCCompiler.cmake"));
    if (change === "compiler") writeFileSync(join(directory, "CMakeFiles/4.4.4/CMakeCCompiler.cmake"), 'set(CMAKE_C_COMPILER "/foreign/compiler")\n');
    const key = { source: "CMAKE_HOME_DIRECTORY", sysroot: "CMAKE_SYSROOT", flags: "CMAKE_CXX_FLAGS" };
    const selected = Object.entries(key).find(([name]) => name === change)?.[1];
    if (selected) writeFileSync(cache, readFileSync(cache, "utf8").replace(new RegExp(`^${selected}:STRING=.*$`, "m"), `${selected}:STRING=foreign`));
    await expect(inspectCryptoOutput(f.context, "wasm32-wasip1", build)).rejects.toThrow();
  } finally { f.remove(); }
});

test("same cached Cargo event is stable but a changed out_dir conflicts", async () => {
  const f = await tlsFixture();
  try {
    const build = await fixtureCrypto(f.context, "host");
    const messages = fixtureMessages(build).replace(/.*build-finished.*\n/, "");
    const parser = new CargoTlsMessages(build.packageId.split("#")[0]! + "#", () => {});
    parser.feed(Buffer.from(messages + messages + '{"reason":"build-finished","success":true}\n'));
    expect(parser.end()).toEqual(build);
  } finally { f.remove(); }
});

test("source contract retains the C++ driver executable as well as its physical hash", async () => {
  const f = await tlsFixture();
  try {
    const logical = join(f.root, "bin/clang++");
    const context = { ...f.context, tools: { ...f.context.tools, cxx: { ...f.context.tools.cxx!, executable: logical } } };
    const handoff = await fixtureHandoff(context);
    expect(handoff.commands).toContain(logical);
    expect(handoff.commands).not.toContain(f.context.tools.cxx!.path);
  } finally { f.remove(); }
});


test("actual source/sysroot fingerprints change with bytes and reject absent inputs", async () => {
  const f = await tlsFixture();
  try {
    const path = join(f.context.sysroot, "header.h");
    writeFileSync(path, "before");
    const original = await treeIdentity(f.context.sysroot, ["header.h"]);
    writeFileSync(path, "after");
    expect(await treeIdentity(f.context.sysroot, ["header.h"])).not.toBe(original);
    rmSync(path);
    await expect(treeIdentity(f.context.sysroot, ["header.h"])).rejects.toThrow();
  } finally { f.remove(); }
});

for (const abi of ["host", "wasm32-wasip1"] as const) test(`realistic ${abi} Ninja rules do not require invented compiler metadata`, async () => {
  const f = await tlsFixture();
  try {
    const build = await fixtureCrypto(f.context, abi);
    const metadata = join(build.outDir, "boringssl/CMakeFiles/4.4.4/CMakeCXXCompiler.cmake");
    expect(readFileSync(metadata, "utf8")).not.toContain("COMPILER_TARGET");
    await expect(inspectCryptoOutput(f.context, abi, build)).resolves.toMatchObject({ abi });
  } finally { f.remove(); }
});

for (const mode of ["missing", "missing-target", "wrong-target", "conflicting-target", "native-target", "description-only"] as const) test(`Ninja compiler ${mode} cannot satisfy the target proof`, async () => {
  const f = await tlsFixture();
  try {
    const abi = mode === "native-target" ? "host" : "wasm32-wasip1";
    const build = await fixtureCrypto(f.context, abi);
    const rules = join(build.outDir, "boringssl/CMakeFiles/rules.ninja");
    let text = readFileSync(rules, "utf8");
    if (mode === "missing") text = "# no compiler rules\n";
    if (mode === "missing-target") text = text.replaceAll(" --target=wasm32-wasip1", "");
    if (mode === "wrong-target") text = text.replaceAll("--target=wasm32-wasip1", "--target=wasm32-unknown-unknown");
    if (mode === "conflicting-target") text = text.replaceAll("--target=wasm32-wasip1", "--target=wasm32-wasip1 --target=wasm32-unknown-unknown");
    if (mode === "native-target") text = text.replaceAll(" $DEFINES", " --target=wasm32-wasip1 $DEFINES");
    if (mode === "description-only") text = text.replaceAll(" --target=wasm32-wasip1", "").replaceAll(" object $out", " --target=wasm32-wasip1 object $out");
    writeFileSync(rules, text);
    await expect(inspectCryptoOutput(f.context, abi, build)).rejects.toThrow(/Ninja compiler/);
  } finally { f.remove(); }
});

test("BoringSSL CXX-only Ninja graphs retain the actual target proof", async () => {
  const f = await tlsFixture();
  try {
    const build = await fixtureCrypto(f.context, "wasm32-wasip1");
    const rules = join(build.outDir, "boringssl/CMakeFiles/rules.ninja");
    const text = readFileSync(rules, "utf8");
    const cxx = text.slice(text.indexOf("rule CXX_COMPILER__"));
    writeFileSync(rules, cxx);
    await expect(inspectCryptoOutput(f.context, "wasm32-wasip1", build)).resolves.toMatchObject({ abi: "wasm32-wasip1" });
  } finally { f.remove(); }
});

for (const abi of ["host", "wasm32-wasip1"] as const) test(`recorded ${abi} Cargo pins compiler selection in dependency directories`, async () => {
  const f = await tlsFixture();
  try {
    const build = await fixtureCrypto(f.context, abi);
    const directory = join(f.context.target, "tls-probe/cargo");
    const env = { ...process.env, GITHUB_WORKSPACE: f.context.workspace, BUNWASM_TLS_CARGO_RECORD_DIR: directory,
      FIXTURE_MESSAGES: fixtureMessages(build), FIXTURE_EXPECT_TOOLCHAIN: f.context.rustToolchain,
      FIXTURE_EXPECT_RUSTC: f.context.tools.rustc!.executable, RUSTUP_TOOLCHAIN: "foreign", RUSTC: "foreign" };
    const command = ["cargo", abi === "host" ? "test" : "clippy", "--locked"].concat(abi === "host" ? [] : ["--target", abi]);
    await recordCargo(command, abi, env, async () => f.context);
    expect(await Bun.file(join(directory, `${abi}.json`)).exists()).toBe(true);
    expect(env.RUSTUP_TOOLCHAIN).toBe("foreign");
    expect(env.RUSTC).toBe("foreign");
  } finally { f.remove(); }
});

test("WASI toolchain compiler metadata does not require compiler cache entries", async () => {
  const f = await tlsFixture();
  try {
    const build = await fixtureCrypto(f.context, "wasm32-wasip1");
    const cache = readFileSync(join(build.outDir, "boringssl/CMakeCache.txt"), "utf8");
    expect(cache).not.toContain("CMAKE_C_COMPILER:");
    expect(cache).not.toContain("CMAKE_CXX_COMPILER:");
    await expect(inspectCryptoOutput(f.context, "wasm32-wasip1", build)).resolves.toMatchObject({ abi: "wasm32-wasip1" });
  } finally { f.remove(); }
});

for (const language of ["C", "CXX"]) test(`WASI rejects conflicting cached ${language} compiler even with valid metadata`, async () => {
  const f = await tlsFixture();
  try {
    const build = await fixtureCrypto(f.context, "wasm32-wasip1");
    const cache = join(build.outDir, "boringssl/CMakeCache.txt");
    writeFileSync(cache, readFileSync(cache, "utf8") + `CMAKE_${language}_COMPILER:FILEPATH=/foreign/compiler\n`);
    await expect(inspectCryptoOutput(f.context, "wasm32-wasip1", build)).rejects.toThrow();
  } finally { f.remove(); }
});
