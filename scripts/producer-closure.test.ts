import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "./guest-source-manifest.ts";
import { launcherReceipt, producerArtifactPaths, producerEngines, producerScopes, producerSelection, requireClosureFiles, verifyHermesLibrary, verifyLauncher, verifyWorkerProof, workerProofLabels } from "./producer-closure.ts";

test("one registry includes all three split engines and only QuickJS for shared-group", () => {
  expect(producerEngines("split")).toEqual(["quickjs", "jsc", "hermes"]);
  expect(producerScopes("split")).toEqual(["core", "quickjs", "jsc", "hermes"]);
  expect(producerSelection("split")).toEqual({ features: ["engine-split", "bun-transpiler", "bun-build"] });
  expect(producerScopes("shared-group")).toEqual(["core", "quickjs"]);
  expect(producerSelection("shared-group").profile).toBe("shared-group");
});

test("closure manifests cannot omit Hermes original/composed receipts, smoke or launcher", () => {
  const paths = producerArtifactPaths("split");
  expect(paths).toContain("hermes/engine.wasm.engine.json");
  expect(paths).toContain("dist/bun-hermes.wasm.build.json");
  expect(paths).toContain("dist/hermes-engine.wasm.engine.json");
  expect(paths).toContain("hermes-smoke.log");
  expect(() => requireClosureFiles("split", paths.map(path => ({ path })))).not.toThrow();
  for (const omitted of ["hermes/engine.wasm.engine.json", "dist/bun-hermes.wasm.build.json", "launcher/bun-wasm.launcher.json"]) {
    expect(() => requireClosureFiles("split", paths.filter(path => path !== omitted).map(path => ({ path })))).toThrow(omitted);
  }
  const shared = producerArtifactPaths("shared-group");
  expect(shared).toContain("worker-proof.log");
  expect(shared.some(path => /jsc|hermes|web\//.test(path))).toBe(false);
});

test("launcher identity rejects changed bytes, stale source and nonexecutables", () => {
  const root = mkdtempSync(join(tmpdir(), "producer-launcher-"));
  try {
    const path = join(root, "launcher");
    const source = { head: "a".repeat(40), tree: "b".repeat(40) };
    writeFileSync(path, "synthetic launcher identity only", { mode: 0o700 });
    const receipt = launcherReceipt(path, source);
    expect(verifyLauncher(path, receipt, source)).toEqual(receipt);
    expect(() => verifyLauncher(path, receipt, { ...source, head: "c".repeat(40) })).toThrow(/source/);
    writeFileSync(path, "different");
    expect(() => verifyLauncher(path, receipt, source)).toThrow(/artifact/);
    chmodSync(path, 0o600);
    expect(() => launcherReceipt(path, source)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("new heap shim source refuses the old native archive before a core build", () => {
  const root = mkdtempSync(join(tmpdir(), "producer-hermes-"));
  try {
    mkdirSync(join(root, "wasi/lib"), { recursive: true });
    mkdirSync(join(root, "crates/bunwasm-hermes/cpp"), { recursive: true });
    writeFileSync(join(root, "wasi/lib/libhermesvm_bunwasm.a"), "archive fixture");
    const shim = join(root, "crates/bunwasm-hermes/cpp/shim.cpp");
    writeFileSync(shim, "old shim");
    const receipt = join(root, "original.json");
    writeFileSync(receipt, JSON.stringify({ sha256: hash("archive fixture"), bytes: 15, shimSha256: hash("old shim") }));
    expect(() => verifyHermesLibrary(root, root, receipt)).not.toThrow();
    writeFileSync(shim, "future b14 heap shim");
    expect(() => verifyHermesLibrary(root, root, receipt)).toThrow(/new matching native generation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("shared proof requires all declared checks once and in order, with a successful exit", () => {
  const output = workerProofLabels.map(label => `PASS ${label}`).join("\n");
  expect(() => verifyWorkerProof(output, 0)).not.toThrow();
  expect(() => verifyWorkerProof(output, 1)).toThrow();
  expect(() => verifyWorkerProof(output.split("\n").slice(1).join("\n"), 0)).toThrow();
  expect(() => verifyWorkerProof(output.split("\n").reverse().join("\n"), 0)).toThrow();
  expect(() => verifyWorkerProof(output + "\nFAIL hidden failure", 0)).toThrow();
});
