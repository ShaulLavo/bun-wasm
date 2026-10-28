import { quickjsPair } from "./quickjs-plan-fixture";
import { expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { needsRust } from "../../scripts/ci-changes.ts";
import { verifyGuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";
import { guestBuilds, hash } from "../../scripts/guest-source-manifest.ts";
import { fixtureReceipt, receiptCli, wasm, withCliReceiptFixture } from "./guest-receipt-fixture.ts";

const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const producer = workflow.split("      - name: Build one host-engine guest for real-browser source cache acceptance\n")[1]?.split("      - uses: actions/upload-artifact@v4")[0];

test("CI keeps the source-cache feature tuple and uses the qualified receipt file contract", () => {
  expect(needsRust(["scripts/guest-source-manifest.ts"])).toBe(true);
  expect(guestBuilds["source-cache-browser"]).toEqual({ artifact: "bun-browser.wasm", package: "bunwasm-cli", features: ["engine-host", "bun-build"], optimizer: "unused" });
  expect(guestBuilds.browser.features).toEqual(["engine-host", "bun-transpiler", "bun-build"]);
  expect(producer).toContain('guest_environment=$(bun scripts/guest-build-receipt.ts environment)\n          eval "$guest_environment"');
  expect(producer).toContain('inputs=$(mktemp "${TMPDIR}/bun-wasm-guest-inputs-XXXXXX")');
  expect(producer).toContain(`trap 'rm -f -- "$inputs"' EXIT`);
  expect(producer).toContain("trap 'exit 130' INT");
  expect(producer).toContain("trap 'exit 143' TERM");
  expect(producer).toContain('bun scripts/guest-build-receipt.ts inputs source-cache-browser > "$inputs"');
  expect(producer).toContain('"$GUEST_CARGO" build --release --locked -j 2 --target wasm32-wasip1 -p bunwasm-cli --no-default-features --features engine-host,bun-build');
  expect(producer).toContain('bun scripts/guest-build-receipt.ts write dist/source-cache-browser/bun-browser.wasm "$inputs"');
  expect(producer).toContain('cp "$CARGO_TARGET_DIR/wasm32-wasip1/release/bun.wasm" dist/source-cache-browser/bun-browser.wasm');
  expect(producer).toContain("git rev-parse HEAD HEAD^{tree} > dist/source-cache-browser/source.txt");
  expect(producer).toContain("sha256sum dist/source-cache-browser/bun-browser.wasm >> dist/source-cache-browser/source.txt");
});

test("source-cache CLI receipts bind synthetic artifact identity without claiming a final Wasm size", async () => {
  await withCliReceiptFixture(async fixture => {
    const started = receiptCli(fixture, "inputs", "source-cache-browser");
    expect(started.exitCode).toBe(0);
    expect(started.stderr.toString()).toBe("");
    const snapshot = join(fixture.root, "dist/source-cache-inputs.json");
    await writeFile(snapshot, started.stdout);
    const finished = receiptCli(fixture, "write", fixture.artifact, snapshot);
    expect(finished.exitCode).toBe(0);
    expect(finished.stderr.toString()).toBe("");
    const bytes = await readFile(fixture.artifact);
    const receipt = await Bun.file(`${fixture.artifact}.build.json`).json();
    verifyGuestBuildReceipt(bytes, receipt);
    expect(receipt.sourceManifest.build).toBe("source-cache-browser");
    expect(receipt.sourceManifest.tools.some((tool: { name: string }) => tool.name === "wasm-opt")).toBe(false);
    expect(receipt.program.core.artifactBytes).toBe(bytes.byteLength);
    expect(() => verifyGuestBuildReceipt(bytes.subarray(1), receipt)).toThrow("does not match artifact bytes");
  });
});

async function withoutOptimizer(fixture: Parameters<typeof receiptCli>[0]) {
  const bin = join(fixture.root, "private/prerequisite-bin");
  await mkdir(bin);
  for (const name of ["git", "bash", "dirname", "mktemp", "rm"]) {
    const path = Bun.which(name);
    if (!path) throw new Error(`Missing test prerequisite: ${name}`);
    await symlink(path, join(bin, name));
  }
  await rm(join(fixture.root, "sdk/bin/wasm-opt"));
  fixture.env.PATH = `${fixture.root}/sdk/bin:${bin}`;
  expect(Bun.spawnSync(["/bin/sh", "-c", "command -v wasm-opt"], { env: fixture.env }).exitCode).not.toBe(0);
}

test("source-cache inputs and write work without the unused optimizer prerequisite", async () => {
  await withCliReceiptFixture(async fixture => {
    await withoutOptimizer(fixture);
    const started = receiptCli(fixture, "inputs", "source-cache-browser");
    expect(started.stderr.toString()).toBe("");
    expect(started.exitCode).toBe(0);
    const snapshot = join(fixture.root, "dist/source-cache-inputs.json");
    await writeFile(snapshot, started.stdout);
    const finished = receiptCli(fixture, "write", fixture.artifact, snapshot);
    expect(finished.stderr.toString()).toBe("");
    expect(finished.exitCode).toBe(0);
    const receipt = await Bun.file(`${fixture.artifact}.build.json`).json();
    verifyGuestBuildReceipt(await readFile(fixture.artifact), receipt);
    expect(receipt.sourceManifest.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
      ["rustc", "cargo", "bun", "node", "rust-lld", "clang", "clang++", "llvm-ar", "wasm-ld", "cmake", "ninja"].sort(),
    );
    expect(() => verifyGuestBuildReceipt(wasm.subarray(1), receipt)).toThrow("does not match artifact bytes");
  });
});

for (const build of ["browser", "jsc", "tools"] as const) test(`${build} still requires optimizer resolution and receipt identity`, async () => {
  await withCliReceiptFixture(async fixture => {
    await withoutOptimizer(fixture);
    const started = receiptCli(fixture, "inputs", build);
    expect(started.exitCode).not.toBe(0);
    expect(started.stderr.toString()).toContain("Missing guest tool: wasm-opt");
    expect(await Bun.file(`${fixture.artifact}.build.json`).exists()).toBe(false);
  });
  const bytes = build === "jsc" ? quickjsPair("jsc").core : wasm;
  const receipt = fixtureReceipt(bytes, build);
  verifyGuestBuildReceipt(bytes, receipt);
  const sourceManifest = { ...receipt.sourceManifest, tools: receipt.sourceManifest.tools.filter(tool => tool.name !== "wasm-opt") };
  const missingOptimizer = { ...receipt, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) };
  expect(() => verifyGuestBuildReceipt(bytes, missingOptimizer)).toThrow("Missing guest optimizer identity");
});

for (const build of ["quickjs", "quickjs-minimal"] as const) test(`${build} requires the common core optimizer identity`, async () => {
  await withCliReceiptFixture(async fixture => {
    const available = receiptCli(fixture, "inputs", build);
    expect(available.stderr.toString()).toBe("");
    expect(available.exitCode).toBe(0);
    expect(JSON.parse(available.stdout.toString()).sourceManifest.tools.some((tool: { name: string }) => tool.name === "wasm-opt")).toBe(true);
    await withoutOptimizer(fixture);
    const absent = receiptCli(fixture, "inputs", build);
    expect(absent.exitCode).not.toBe(0);
    expect(absent.stderr.toString()).toContain("Missing guest tool: wasm-opt");
  });
});
