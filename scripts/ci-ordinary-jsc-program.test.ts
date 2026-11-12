import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCustomSection, ENGINE_SECTION } from "../src/engine-kind.ts";
import { fixtureReceipt } from "../tests/package/guest-receipt-fixture.ts";
import { record } from "./guest-core-receipt.ts";
import { quickjsPair } from "../tests/package/quickjs-plan-fixture.ts";
import { artifactIdentity } from "./guest-build-receipt.ts";
import { hash } from "./guest-source-manifest.ts";
import { exportOrdinaryJscProgram, ordinaryJscFiles, verifyOrdinaryJscProgram } from "./ci-ordinary-jsc-program.ts";
import { jscEmbeddingArchives } from "./jsc-embedding.ts";
import { needsJsc, needsRust } from "./ci-changes.ts";
import { discoverChecks } from "./test-checks.ts";

async function fixture(action: (directory: string, source: { head: string; tree: string }) => Promise<void>, maximum = 16384) {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-ordinary-jsc-"));
  try {
    const pair = quickjsPair("jsc", maximum);
    const tag = appendCustomSection(new Uint8Array(), ENGINE_SECTION, new TextEncoder().encode("jsc"));
    const untagged = pair.core.subarray(0, pair.core.length - tag.length);
    const build = fixtureReceipt(pair.core, "jsc", pair.side);
    if (!("engineOrigin" in build)) throw new Error("Expected paired fixture");
    const source = build.sourceManifest.source;
    const stamp = "c".repeat(64);
    const archives = jscEmbeddingArchives.map(path => ({ path, sha256: hash(path) }));
    const groups = build.sourceManifest.groups.map(group => group.name === "jsc-prebuild"
      ? { name: group.name, files: [{ path: "build/jsc/.bunwasm-inputs", sha256: hash(stamp + "\n"), bytes: 65 }].concat(archives.map(file => ({ ...file, bytes: 7 }))) } : group);
    const sourceManifest = { ...build.sourceManifest, groups };
    const engineOrigin = { ...build.engineOrigin, inputs: { ...build.engineOrigin.inputs, source: { head: "1".repeat(40), tree: "2".repeat(40) } } };
    const coreContent = { selection: { features: ["engine-split", "bun-transpiler", "bun-build"] } };
    const coreOrigin = { schema: 1, inputs: { schema: 1, scope: "core", source: { head: "3".repeat(40), tree: "4".repeat(40) }, content: coreContent, contentSha256: hash(JSON.stringify(coreContent)) }, artifact: artifactIdentity(untagged) };
    const content = [pair.core, pair.side, JSON.stringify(coreOrigin, null, 2) + "\n", JSON.stringify(engineOrigin, null, 2) + "\n",
      JSON.stringify({ ...build, engineOrigin, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) }, null, 2) + "\n",
      JSON.stringify({ sourceHead: source.head, sourceTree: source.tree, jscInputsSha256: stamp, archives, program: build.program }, null, 2) + "\n"];
    for (const [index, name] of ordinaryJscFiles.entries()) await Bun.write(join(directory, name), content[index]!);
    await action(directory, source);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("exports the raw split pair and every original receipt without rewriting cached origins", async () => {
  await fixture(async (directory, source) => {
    const output = join(directory, "export");
    await exportOrdinaryJscProgram(directory, join(directory, "bun-core.wasm.core.json"), output, source);
    for (const name of ordinaryJscFiles) expect(await Bun.file(join(output, name)).bytes()).toEqual(await Bun.file(join(directory, name)).bytes());
    const expected: readonly string[] = ordinaryJscFiles;
    expect((await readdir(output)).sort()).toEqual(expected.concat(["delivery.json", "source.txt"]).sort());
    const result = await verifyOrdinaryJscProgram(output, join(output, "bun-core.wasm.core.json"), source);
    expect(await Bun.file(join(output, "delivery.json")).json()).toEqual(result.delivery);
    expect(result.delivery.components.core.source.head).toBe("3".repeat(40));
    expect(result.delivery.components.side.source.head).toBe("1".repeat(40));
    expect(result.delivery.source).toEqual(source);
    expect(result.delivery.capacity).toMatchObject({ maximumMemoryBytes: 1073741824, coreMemory: { shared: false, origin: "defined", maximum: 16384 }, sideMemory: { shared: false, origin: "imported" }, environment: { BUN_WASM_STACK_KIB: "192" } });
    expect(await Bun.file(join(output, "source.txt")).text()).toBe(`${source.head}\n${source.tree}\n`);
    await expect(exportOrdinaryJscProgram(directory, join(directory, "bun-core.wasm.core.json"), output, source)).rejects.toThrow();
    expect(await Bun.file(join(output, "bun-jsc.wasm")).bytes()).toEqual(await Bun.file(join(directory, "bun-jsc.wasm")).bytes());
  });
});

async function corrupt(directory: string, name: string, mutation: (value: Record<string, unknown>) => unknown) {
  await Bun.write(join(directory, name), JSON.stringify(mutation(await Bun.file(join(directory, name)).json())));
}

const defects = ["core bytes", "side bytes", "core scope", "core profile", "side scope", "side origin", "build engine", "build profile", "embedding source", "embedding archive", "embedding stamp", "missing receipt", "source"] as const;
for (const defect of defects) {
  test(`rejects ${defect} before creating an export`, async () => {
    await fixture(async (directory, source) => {
      const output = join(directory, "export");
      await damage(directory, defect);
      const expected = defect === "source" ? { ...source, head: "0".repeat(40) } : source;
      await expect(exportOrdinaryJscProgram(directory, join(directory, "bun-core.wasm.core.json"), output, expected)).rejects.toThrow();
      expect(await readdir(directory)).not.toContain("export");
    });
  });
}

async function damage(directory: string, defect: typeof defects[number]) {
  if (defect === "source") return;
  if (defect === "missing receipt") return rm(join(directory, "bun-jsc.wasm.embedding.json"));
  if (defect === "core bytes" || defect === "side bytes") {
    const name = defect === "core bytes" ? "bun-jsc.wasm" : "jsc-engine.wasm";
    return void await Bun.write(join(directory, name), appendCustomSection(await Bun.file(join(directory, name)).bytes(), "changed", new Uint8Array([1])));
  }
  if (defect.startsWith("embedding")) return corrupt(directory, "bun-jsc.wasm.embedding.json", value => ({ ...value, [defect === "embedding source" ? "sourceHead" : defect === "embedding stamp" ? "jscInputsSha256" : "archives"]: defect === "embedding archive" ? [] : "0".repeat(defect === "embedding source" ? 40 : 64) }));
  if (defect.startsWith("build")) return corrupt(directory, "bun-jsc.wasm.build.json", value => ({ ...value, [defect === "build engine" ? "program" : "profile"]: defect === "build engine" ? { kind: "single", core: {} } : "shared-group" }));
  const name = defect.startsWith("core") ? "bun-core.wasm.core.json" : "jsc-engine.wasm.engine.json";
  const value = await Bun.file(join(directory, name)).json();
  if (defect === "side origin") value.inputs.source.head = "0".repeat(40);
  else if (defect === "core profile") {
    value.inputs.content.selection.profile = "shared-group";
    value.inputs.contentSha256 = hash(JSON.stringify(value.inputs.content));
  } else value.inputs.scope = defect === "core scope" ? "jsc" : "quickjs";
  await Bun.write(join(directory, name), JSON.stringify(value));
}

test.each([8192, 32768])("rejects a %i-page core even when its original receipts match", async maximum => {
  await fixture(async (directory, source) => {
    await expect(exportOrdinaryJscProgram(directory, join(directory, "bun-core.wasm.core.json"), join(directory, "export"), source)).rejects.toThrow("private 1 GiB");
    expect(await readdir(directory)).not.toContain("export");
  }, maximum);
});

test("the normal Rust job exports only selected JSC after its existing blocking gates", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text());
  if (!record(workflow) || !record(workflow.jobs) || !record(workflow.jobs.rust) || !Array.isArray(workflow.jobs.rust.steps)) throw new Error("Expected Rust workflow steps");
  const steps = workflow.jobs.rust.steps.map(step => {
    if (!record(step)) throw new Error("Expected workflow step");
    return step;
  });
  const exporter = steps.find((step: { name?: string }) => step.name === "Export the validated ordinary JSC pair");
  const upload = steps.find(step => record(step.with) && step.with.name === "ordinary-jsc-program");
  if (!exporter || !upload) throw new Error("Missing ordinary JSC export steps");
  expect(exporter).toEqual({ name: "Export the validated ordinary JSC pair", if: "needs.quality.outputs.jsc == 'true'", run: 'source env.sh\nbun scripts/ci-ordinary-jsc-program.ts export "$RUNNER_TEMP/ordinary-jsc-program"\n' });
  expect(upload).toEqual({ uses: "actions/upload-artifact@v4", "timeout-minutes": 5, if: "needs.quality.outputs.jsc == 'true'", with: { name: "ordinary-jsc-program", path: "${{ runner.temp }}/ordinary-jsc-program/", "if-no-files-found": "error", "retention-days": 1 } });
  for (const name of ["Build the JSC Cargo guest", "Blocking JSC embedding and allocation checks", "Blocking native fixture checks"]) expect(steps.indexOf(exporter)).toBeGreaterThan(steps.findIndex((step: { name?: string }) => step.name === name));
  expect(steps.indexOf(upload)).toBe(steps.indexOf(exporter) + 1);
  expect(needsRust(["scripts/ci-ordinary-jsc-program.ts"])).toBe(true);
  expect(needsJsc(["scripts/ci-ordinary-jsc-program.ts"])).toBe(true);
  expect(needsJsc(["scripts/ci-program-delivery.ts"])).toBe(true);
  expect(discoverChecks().filter(check => check.path === "scripts/ci-ordinary-jsc-program.test.ts")).toEqual([{ owner: "quality", path: "scripts/ci-ordinary-jsc-program.test.ts", localRuntime: false, batch: "default" }]);
});
