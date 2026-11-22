import { expandedCiWorkflow } from "./fixtures/ci-jsc-workflow";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCustomSection } from "../src/engine-kind.ts";
import { record } from "./guest-core-receipt.ts";
import { hash } from "./guest-source-manifest.ts";
import { exportOrdinaryJscProgram, ordinaryJscFiles, verifyOrdinaryJscProgram } from "./ci-ordinary-jsc-program.ts";
import { deliveryFixtureSource, writeJscDeliveryFixture } from "./fixtures/ordinary-web-delivery.ts";
import { needsJsc, needsRust } from "./ci-changes.ts";
import { discoverChecks } from "./test-checks.ts";

async function fixture(action: (directory: string, source: { head: string; tree: string }) => Promise<void>, maximum = 16384) {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-ordinary-jsc-"));
  try {
    const source = deliveryFixtureSource;
    await writeJscDeliveryFixture(directory, source, maximum);
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
    expect(await Bun.file(join(output, "delivery.json")).json()).toStrictEqual(result.delivery);
    expect(result.delivery.capacity.sideMemory).not.toHaveProperty("maximum");
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

test("ordinary guest production exports only selected JSC after its backing verification", async () => {
  const workflow = Bun.YAML.parse(expandedCiWorkflow());
  if (!record(workflow) || !record(workflow.jobs) || !record(workflow.jobs["ordinary-build"]) || !Array.isArray(workflow.jobs["ordinary-build"].steps)) throw new Error("Expected ordinary-build workflow steps");
  const steps = workflow.jobs["ordinary-build"].steps.map(step => {
    if (!record(step)) throw new Error("Expected workflow step");
    return step;
  });
  const exporter = steps.find((step: { name?: string }) => step.name === "Export the validated ordinary JSC pair");
  const upload = steps.find(step => record(step.with) && step.with.name === "ordinary-jsc-program");
  if (!exporter || !upload) throw new Error("Missing ordinary JSC export steps");
  expect(exporter.run).toBe('source env.sh\nbun scripts/ci-ordinary-jsc-program.ts export "$RUNNER_TEMP/ordinary-jsc-program"\n');
  expect(String(exporter.if)).toContain("needs.selection.outputs.jsc == 'true'");
  expect(upload).toMatchObject({ uses: "actions/upload-artifact@v4", "timeout-minutes": 5, with: { name: "ordinary-jsc-program", path: "${{ runner.temp }}/ordinary-jsc-program/", "if-no-files-found": "error", "retention-days": 1 } });
  expect(String(upload.if)).toContain("needs.selection.outputs.jsc == 'true'");
  for (const name of ["Build the JSC Cargo guest", "Verify JSC embedding source and native backing"]) expect(steps.indexOf(exporter)).toBeGreaterThan(steps.findIndex((step: { name?: string }) => step.name === name));
  expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(exporter));
  expect(needsRust(["scripts/ci-ordinary-jsc-program.ts"])).toBe(true);
  expect(needsJsc(["scripts/ci-ordinary-jsc-program.ts"])).toBe(true);
  expect(needsJsc(["scripts/ci-program-delivery.ts"])).toBe(true);
  expect(discoverChecks().filter(check => check.path === "scripts/ci-ordinary-jsc-program.test.ts")).toEqual([{ owner: "quality", path: "scripts/ci-ordinary-jsc-program.test.ts", localRuntime: false, batch: "default" }]);
});
