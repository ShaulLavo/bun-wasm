import { quickjsPair } from "./quickjs-plan-fixture";
import { expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { needsRust } from "../../scripts/ci-changes.ts";
import { verifyGuestBuildReceipt } from "../../scripts/guest-build-receipt.ts";
import { guestBuilds, hash } from "../../scripts/guest-source-manifest.ts";
import { fixtureReceipt, receiptCli, wasm, withCliReceiptFixture } from "./guest-receipt-fixture.ts";

const workflow = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const producer = workflow.split("      - name: Build the standard Browser guest once\n")[1]?.split("      - name: Build the JSC Cargo guest\n")[0];

test("CI uses one standard Browser recipe while C1 retains its distinct source-cache recipe", () => {
  expect(needsRust(["scripts/guest-source-manifest.ts"])).toBe(true);
  expect(guestBuilds["source-cache-browser"]).toEqual({ artifact: "bun-browser.wasm", package: "bunwasm-cli", features: ["engine-host", "bun-build"], optimizer: "unused" });
  expect(guestBuilds.browser.features).toEqual(["engine-host", "bun-transpiler", "bun-build"]);
  expect(producer).toContain('source env.sh\n          BROWSER_CARGO_TARGET_DIR="$CARGO_TARGET_DIR" JOBS=2 bash scripts/build-bun-browser.sh');
  expect(workflow).not.toContain("source-cache-browser-guest");
  expect(workflow).not.toContain("dist/source-cache-browser");
  expect(workflow.match(/bash scripts\/build-bun-browser\.sh/g)).toHaveLength(1);
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
