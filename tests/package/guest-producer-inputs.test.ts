import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareGuestBuildInputs, verifyGuestBuildReceipt, writeGuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";
import { hash } from "../../scripts/guest-source-manifest.ts";
import { fixtureGit, receiptCli, withCliReceiptFixture, withReceiptFixture } from "./guest-receipt-fixture.ts";

const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

function quickjsNativeReceiptFragment(): string {
  const step = workflow.split("      - name: Blocking native checks with one owned JSC prebuild\n")[1]?.split("      - name: Blocking JSC embedding")[0];
  const native = step?.match(/^          run_native_checks\(\) \{\n([^]*?)^          \}/m)?.[1];
  if (!native) throw new Error("Missing native check workflow fragment");
  const input = native.indexOf("guest-build-receipt.ts inputs");
  if (input < 0) throw new Error("Missing QuickJS receipt input command");
  const inputLine = native.lastIndexOf("\n", input) + 1;
  const environment = native.indexOf("            guest_environment=$(bun scripts/guest-build-receipt.ts environment)");
  const start = environment >= 0 ? environment : inputLine;
  const write = native.indexOf("            bun scripts/guest-build-receipt.ts write dist/bun.wasm", start);
  if (write < 0) throw new Error("Missing QuickJS receipt write command");
  const cleanup = native.indexOf("\n            guest_inputs=", write);
  const end = native.indexOf("\n", cleanup >= 0 ? cleanup + 1 : write);
  return ["set -euo pipefail", "source env.sh", native.slice(start, end < 0 ? native.length : end)]
    .join("\n").replace(/^ {12}/gm, "");
}

async function executable(path: string, source: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${source}\n`);
  await chmod(path, 0o700);
}

async function snapshot(fixture: Parameters<typeof receiptCli>[0]) {
  const started = receiptCli(fixture, "inputs", "browser");
  expect(started.stderr.toString()).toBe("");
  expect(started.exitCode).toBe(0);
  const path = join(fixture.root, "dist/inputs.json");
  await writeFile(path, started.stdout);
  return path;
}

for (const path of ["decrepit/cfb/cfb.cc", "decrepit/blowfish/blowfish.cc", "decrepit/macros.h"]) test(`producer inventory rejects compiled BoringSSL drift: ${path}`, async () => {
  await withCliReceiptFixture(async fixture => {
    await writeFile(join(fixture.root, "vendor/boringssl", path), "original compiled input\n");
    const inputs = await snapshot(fixture);
    await writeFile(join(fixture.root, "vendor/boringssl", path), "changed compiled source\n");
    const finished = receiptCli(fixture, "write", fixture.artifact, inputs);
    expect(finished.exitCode).not.toBe(0);
    expect(finished.stderr.toString()).toContain("changed during the build");
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(false);
  });
});

for (const override of ["", "private/runtime-override"]) test(`qualified CLI refuses selected runtime override ${JSON.stringify(override)}`, async () => {
  await withCliReceiptFixture(async fixture => {
    fixture.env.BUNWASM_JS_OVERRIDE_DIR = override;
    const started = receiptCli(fixture, "inputs", "browser");
    expect(started.exitCode).not.toBe(0);
    expect(started.stderr.toString()).toContain("BUNWASM_JS_OVERRIDE_DIR");
  });
});

test("runtime override selected after snapshot cannot get a receipt", async () => {
  await withCliReceiptFixture(async fixture => {
    const inputs = await snapshot(fixture);
    fixture.env.BUNWASM_JS_OVERRIDE_DIR = "private/runtime-override";
    expect(receiptCli(fixture, "write", fixture.artifact, inputs).exitCode).not.toBe(0);
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(false);
  });
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) for (const path of ["src/input.rs", "Cargo.toml", "Cargo.lock"]) test(`imported Bun ${path} cannot hide changes behind ${flag}`, async () => {
  await withReceiptFixture(async options => {
    const vendor = join(options.repository, "vendor/bun");
    fixtureGit(vendor, "update-index", flag, path);
    await writeFile(join(vendor, path), "hidden dirty input\n");
    const indexBefore = hash(await readFile(join(vendor, ".git/index")));
    const flagsBefore = fixtureGit(vendor, "ls-files", "-v");
    expect(fixtureGit(vendor, "status", "--porcelain")).toBe("");
    await expect(prepareGuestBuildInputs(options)).rejects.toThrow("differs from committed source");
    expect(hash(await readFile(join(vendor, ".git/index")))).toBe(indexBefore);
    expect(fixtureGit(vendor, "ls-files", "-v")).toBe(flagsBefore);
    expect(await readFile(join(vendor, path), "utf8")).toBe("hidden dirty input\n");
  });
});

test("hidden imported source drift after snapshot is refused", async () => {
  await withReceiptFixture(async (options, artifact) => {
    const inputs = await prepareGuestBuildInputs(options);
    const vendor = join(options.repository, "vendor/bun");
    fixtureGit(vendor, "update-index", "--assume-unchanged", "src/input.rs");
    await writeFile(join(vendor, "src/input.rs"), "hidden during build\n");
    await expect(writeGuestBuildReceipt(options, artifact, inputs)).rejects.toThrow("differs from committed source");
  });
});

test("CLI resolves the selected Node dispatcher and Rust linker to consumed executables", async () => {
  await withCliReceiptFixture(async fixture => {
    const inputs = JSON.parse(await readFile(await snapshot(fixture), "utf8"));
    expect(inputs.sourceManifest.tools).toContainEqual({ name: "node", path: fixture.node, sha256: hash(await readFile(fixture.node)), version: "fixture node 1" });
    expect(inputs.sourceManifest.tools).toContainEqual({ name: "rust-lld", path: fixture.linker, sha256: hash(await readFile(fixture.linker)), version: "fixture rust-lld 1" });
    expect(inputs.sourceManifest.tools.find((tool: { name: string }) => tool.name === "rustc").path).toBe(fixture.rustc);
  });
});

for (const tool of ["node", "linker", "rustc"] as const) test(`CLI rejects actual ${tool} byte drift behind same-version probes`, async () => {
  await withCliReceiptFixture(async fixture => {
    const inputs = await snapshot(fixture);
    await writeFile(fixture[tool], (await readFile(fixture[tool], "utf8")) + "# changed actual executable\n");
    expect(receiptCli(fixture, "write", fixture.artifact, inputs).exitCode).not.toBe(0);
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(false);
  });
});

test("CLI refuses an unresolved explicit forwarding compiler", async () => {
  await withCliReceiptFixture(async fixture => {
    const shim = join(fixture.root, "private/rustc-shim");
    await executable(shim, `exec ${JSON.stringify(fixture.rustc)} "$@"`);
    fixture.env.RUSTC = shim;
    const started = receiptCli(fixture, "inputs", "browser");
    expect(started.exitCode).not.toBe(0);
    expect(started.stderr.toString()).toContain("RUSTC");
  });
});

test("producer environment pins the inventoried compiler, cargo, Node and linker", async () => {
  await withCliReceiptFixture(async fixture => {
    const selected = receiptCli(fixture, "environment");
    expect(selected.exitCode).toBe(0);
    const probe = Bun.spawnSync(["bash", "-eu", "-c", `${selected.stdout}\nprintf '%s\\n' "$RUSTC" "$GUEST_CARGO" "$CARGO_TARGET_WASM32_WASIP1_LINKER"; command -v node`], { env: fixture.env, cwd: fixture.root });
    expect(probe.exitCode).toBe(0);
    expect(probe.stdout.toString().trim().split("\n")).toEqual([fixture.rustc, join(fixture.root, "fake-tool"), fixture.linker, fixture.node]);
  });
});

for (const name of ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_TARGET_WASM32_WASIP1_LINKER", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_TARGET_WASM32_WASIP1_RUSTFLAGS"]) test(`qualified CLI refuses unsupported compiler selection via ${name}`, async () => {
  await withCliReceiptFixture(async fixture => {
    fixture.env[name] = name.includes("FLAGS") ? "-C linker=/unresolved/linker" : fixture.node;
    const started = receiptCli(fixture, "inputs", "browser");
    expect(started.exitCode).not.toBe(0);
    expect(started.stderr.toString()).toContain(name);
  });
});

test("explicit active compiler is accepted and a Node dispatcher retarget is detected", async () => {
  await withCliReceiptFixture(async fixture => {
    fixture.env.RUSTC = fixture.rustc;
    const inputs = await snapshot(fixture);
    const alternate = join(fixture.root, "private/alternate/bin/node");
    await executable(alternate, `if [ "$1" = "-p" ]; then echo ${JSON.stringify(alternate)}; else echo 'fixture node 1'; fi`);
    await executable(join(fixture.root, "sdk/bin/node"), `exec ${JSON.stringify(alternate)} "$@"`);
    expect(receiptCli(fixture, "write", fixture.artifact, inputs).exitCode).not.toBe(0);
  });
});

async function browserProducerFixture(fixture: Parameters<typeof receiptCli>[0]) {
  const root = fixture.root;
  await copyFile(new URL("../../scripts/build-bun-browser.sh", import.meta.url), join(root, "scripts/build-bun-browser.sh"));
  await writeFile(join(root, "scripts/build-wasi-sysroot.ts"), "export {};\n");
  await executable(join(root, "scripts/sync-crypto.sh"), "exit 0");
  await writeFile(join(root, "env.sh"), `export TMPDIR=${JSON.stringify(join(root, "private"))}\n`);
  fixtureGit(root, "add", "scripts", "env.sh");
  fixtureGit(root, "commit", "-m", "synthetic browser producer, no compiler invocation");
  const raw = join(root, "private/target/wasm32-wasip1/release/bun.wasm");
  await executable(join(root, "fake-tool"), `
if [ "$1" = build ]; then
  printf '%s\\n' "$RUSTC" "$CARGO_TARGET_WASM32_WASIP1_LINKER" "$(command -v node)" > ${JSON.stringify(join(root, "dist/producer.txt"))}
  mkdir -p ${JSON.stringify(dirname(raw))}
  printf '\\000asm\\001\\000\\000\\000' > ${JSON.stringify(raw)}
  exit 0
fi
if [ "$1" = -O2 ]; then
  while [ "$1" != -o ]; do shift; done
  cp ${JSON.stringify(raw)} "$2"
  exit 0
fi
echo 'fixture tool 1'
`);
  fixture.env.BROWSER_CARGO_TARGET_DIR = join(root, "private/target");
  return Bun.spawnSync(["bash", join(root, "scripts/build-bun-browser.sh")], { env: fixture.env, cwd: root });
}

test("actual browser entry point uses pinned tools for a fixture-only artifact producer", async () => {
  await withCliReceiptFixture(async fixture => {
    const finished = await browserProducerFixture(fixture);
    expect(finished.stderr.toString()).toBe("");
    expect(finished.exitCode).toBe(0);
    expect((await readFile(join(fixture.root, "dist/producer.txt"), "utf8")).trim().split("\n")).toEqual([fixture.rustc, fixture.linker, fixture.node]);
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(true);
  });
});

test("actual browser entry point stops before a fixture producer on an unresolved compiler", async () => {
  await withCliReceiptFixture(async fixture => {
    fixture.env.RUSTC = fixture.node;
    const finished = await browserProducerFixture(fixture);
    expect(finished.exitCode).not.toBe(0);
    expect(finished.stderr.toString()).toContain("RUSTC");
    expect(await Bun.file(join(fixture.root, "dist/producer.txt")).exists()).toBe(false);
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(false);
  });
});


test("executed native workflow fragment selects QuickJS receipt inputs and cleans its snapshot", async () => {
  await withCliReceiptFixture(async fixture => {
    const target = join(fixture.root, "private/target");
    fixture.env.CARGO_TARGET_DIR = target;
    const exclude = join(fixture.root, ".git/info/exclude");
    await writeFile(exclude, `${await readFile(exclude, "utf8")}\nbun-wasm-guest-inputs-*\n`);
    await writeFile(join(fixture.root, "fake-tool"), `#!/bin/sh
if [ "$1" = build ]; then
  mkdir -p "$CARGO_TARGET_DIR/wasm32-wasip1/release"
  printf '\\000asm\\001\\000\\000\\000' > "$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm"
  exit 0
fi
printf 'fixture tool 1\n'
`);
    await chmod(join(fixture.root, "fake-tool"), 0o700);
    const finished = Bun.spawnSync(["bash", "-eu", "-o", "pipefail", "-c", quickjsNativeReceiptFragment()], { cwd: fixture.root, env: fixture.env });
    expect(finished.stderr.toString()).toBe("");
    expect(finished.exitCode).toBe(0);
    const artifact = join(fixture.root, "dist/bun.wasm");
    const receipt = await Bun.file(`${artifact}.build.json`).json();
    verifyGuestBuildReceipt(await readFile(artifact), receipt);
    expect(receipt.sourceManifest.build).toBe("quickjs");
    expect((await readdir(fixture.root)).filter(name => name.startsWith("bun-wasm-guest-inputs-")).length).toBe(0);
  });
});
