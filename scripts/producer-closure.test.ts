import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launcherReceipt, producerArtifactPaths, producerEngines, producerScopes, producerSelection, requireClosureFiles, verifyLauncher, verifyWorkerProof, workerProofLabels } from "./producer-closure.ts";

test("one registry includes both supported split engines and only QuickJS for shared-group", () => {
  expect(producerEngines("split")).toEqual(["quickjs", "jsc"]);
  expect(producerScopes("split")).toEqual(["core", "quickjs", "jsc"]);
  expect(producerSelection("split")).toEqual({ features: ["engine-split", "bun-transpiler", "bun-build"] });
  expect(producerScopes("shared-group")).toEqual(["core", "quickjs"]);
  expect(producerSelection("shared-group").profile).toBe("shared-group");
});

test("closure manifests require both paired receipts, JSC embedding, smoke and exact launcher", () => {
  const paths = producerArtifactPaths("split");
  expect(paths.some(path => /hermes/i.test(path))).toBe(false);
  expect(() => requireClosureFiles("split", paths.map(path => ({ path })))).not.toThrow();
  for (const omitted of ["quickjs/engine.wasm.engine.json", "dist/bun-jsc.wasm.build.json", "dist/jsc-engine.wasm.engine.json", "dist/bun-jsc.wasm.embedding.json", "jsc-smoke.log", "jsc-node-smoke.log", "launcher/bun-wasm.launcher.json"]) {
    expect(() => requireClosureFiles("split", paths.filter(path => path !== omitted).map(path => ({ path })))).toThrow(omitted);
  }
  const shared = producerArtifactPaths("shared-group");
  expect(shared).toContain("worker-proof.log");
  expect(shared.some(path => /jsc|hermes|web\//.test(path))).toBe(false);
});

for (const path of ["hermes/engine.wasm", "dist/bun-hermes.wasm", "dist/bun-hermes.wasm.build.json", "dist/hermes-engine.wasm.engine.json", "inputs/hermes-vm.json", "web/hermes-engine.wasm.gz", "hermes-smoke.log"]) {
  test(`closure rejects withdrawn output or receipt ${path}`, () => {
    const files = producerArtifactPaths("split").concat([path]).map(path => ({ path }));
    expect(() => requireClosureFiles("split", files)).toThrow("Withdrawn engine");
  });
}

test("split closure retains the verified shell, network and program-family WASM assets", () => {
  const dependencies = ["web/programs/shell-engine.wasm", "web/programs/env.wasm", "web/network.wasm", "web/chunks/network.wasm", "web/__bunwasm/network.wasm", "web/__bunwasm/chunks/network.wasm"];
  for (const family of ["coreutils", "findutils", "grep", "ripgrep", "sed"]) {
    for (const suffix of ["", ".gz", ".br"]) dependencies.push(`web/programs/base/waffle-${family}/dist/${family}.wasm${suffix}`);
  }
  const files = producerArtifactPaths("split").concat(dependencies).map(path => ({ path }));
  expect(() => requireClosureFiles("split", files)).not.toThrow();
  expect(() => requireClosureFiles("split", files.concat([{ path: "web/network.wasm" }]))).toThrow("Repeated");
  expect(() => requireClosureFiles("shared-group", producerArtifactPaths("shared-group").concat(dependencies).map(path => ({ path })))).toThrow("Unexpected");
});

test("dependency WASM does not admit extra engine payloads or unknown dependency families", () => {
  for (const path of ["web/bun-spidermonkey.wasm.gz", "web/unknown-engine.wasm", "web/quickjs.wasm", "web/quickjs.wasm.br", "web/programs/unknown.wasm", "web/programs/base/waffle-unknown/dist/unknown.wasm.gz", "web/__bunwasm/bun-spidermonkey.wasm.gz"]) {
    expect(() => requireClosureFiles("split", producerArtifactPaths("split").concat([path]).map(path => ({ path })))).toThrow(`Unexpected producer manifest artifact: ${path}`);
  }
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

test("shared proof requires all declared checks once and in order, with a successful exit", () => {
  const output = workerProofLabels.map(label => `PASS ${label}`).join("\n");
  expect(() => verifyWorkerProof(output, 0)).not.toThrow();
  expect(() => verifyWorkerProof(output, 1)).toThrow();
  expect(() => verifyWorkerProof(output.split("\n").slice(1).join("\n"), 0)).toThrow();
  expect(() => verifyWorkerProof(output.split("\n").reverse().join("\n"), 0)).toThrow();
  expect(() => verifyWorkerProof(output + "\nFAIL hidden failure", 0)).toThrow();
});
