import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureReceipt, wasm } from "../tests/package/guest-receipt-fixture.ts";
import { appendCustomSection } from "../src/engine-kind.ts";
import { exportBrowserProgram, verifyBrowserProgram } from "./ci-browser-program.ts";
import { needsRust } from "./ci-changes.ts";
import { record } from "./guest-core-receipt.ts";
import { hash } from "./guest-source-manifest.ts";
import { discoverChecks } from "./test-checks.ts";
import { writeProgramDelivery } from "./ci-program-delivery.ts";

async function fixture(action: (directory: string, source: { head: string; tree: string }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "bun-wasm-browser-program-"));
  try {
    for (const build of ["browser", "tools"] as const) {
      await Bun.write(join(directory, `bun-${build}.wasm`), wasm);
      await Bun.write(join(directory, `bun-${build}.wasm.build.json`), JSON.stringify(fixtureReceipt(wasm, build), null, 2) + "\n");
    }
    await action(directory, fixtureReceipt(wasm, "browser").sourceManifest.source);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("exports one standard Browser and same-source tools guest with unmodified raw bytes and receipts", async () => {
  await fixture(async (directory, source) => {
    const output = join(directory, "export");
    await exportBrowserProgram(directory, output, source);
    const result = await verifyBrowserProgram(output, source);
    for (const file of result.files) expect(file.bytes).toEqual(await Bun.file(join(directory, file.name)).bytes());
    expect((await readdir(output)).sort()).toEqual(result.files.map(file => file.name).concat(["delivery.json", "source.txt"]).sort());
    expect(await Bun.file(join(output, "delivery.json")).json()).toEqual(result.delivery);
    expect(result.delivery.programs.map(program => program.build)).toEqual(["browser", "tools"]);
    expect(await Bun.file(join(output, "source.txt")).text()).toBe(`${source.head}\n${source.tree}\n`);
    await expect(exportBrowserProgram(directory, output, source)).rejects.toThrow();
    expect(await Bun.file(join(output, "delivery.json")).json()).toEqual(result.delivery);
  });
});

for (const defect of ["source-cache recipe", "browser bytes", "tools bytes", "missing tools receipt", "tools source", "patched Bun", "optimizer"] as const) {
  test(`rejects ${defect} before creating delivery output`, async () => {
    await fixture(async (directory, source) => {
      await damage(directory, defect);
      await expect(exportBrowserProgram(directory, join(directory, "export"), source)).rejects.toThrow();
      expect(await readdir(directory)).not.toContain("export");
    });
  });
}

async function damage(directory: string, defect: string) {
  if (defect === "source-cache recipe") return void await Bun.write(join(directory, "bun-browser.wasm.build.json"), JSON.stringify(fixtureReceipt(wasm, "source-cache-browser")));
  if (defect === "missing tools receipt") return rm(join(directory, "bun-tools.wasm.build.json"));
  if (defect.endsWith("bytes")) return void await Bun.write(join(directory, defect === "browser bytes" ? "bun-browser.wasm" : "bun-tools.wasm"), appendCustomSection(wasm, "changed", new Uint8Array([1])));
  const receipt = fixtureReceipt(wasm, defect === "optimizer" ? "browser" : "tools");
  if (defect === "patched Bun") return void await Bun.write(join(directory, "bun-tools.wasm.build.json"), JSON.stringify({ ...receipt, bunHead: "9".repeat(40) }));
  const sourceManifest = { ...receipt.sourceManifest, source: defect === "tools source" ? { head: "1".repeat(40), tree: "2".repeat(40) } : receipt.sourceManifest.source,
    tools: defect === "optimizer" ? receipt.sourceManifest.tools.filter(tool => tool.name !== "wasm-opt") : receipt.sourceManifest.tools };
  await Bun.write(join(directory, defect === "optimizer" ? "bun-browser.wasm.build.json" : "bun-tools.wasm.build.json"), JSON.stringify({ ...receipt, sourceManifest, sourceManifestSha256: hash(JSON.stringify(sourceManifest)) }));
}

test("a failed delivery write removes its own partial output", async () => {
  await fixture(async (directory, source) => {
    const output = join(directory, "partial");
    await expect(writeProgramDelivery(output, [{ name: "source.txt/child", bytes: wasm }], { source })).rejects.toThrow();
    expect(await readdir(directory)).not.toContain("partial");
  });
});

function workflowSteps(value: unknown) {
  if (!record(value) || !Array.isArray(value.steps)) throw new Error("Expected workflow steps");
  return value.steps.map(step => {
    if (!record(step)) throw new Error("Expected workflow step");
    return step;
  });
}

test("one maintained standard recipe feeds native, Web and source-cache/transfer consumers", async () => {
  const text = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
  const workflow = Bun.YAML.parse(text);
  if (!record(workflow) || !record(workflow.jobs)) throw new Error("Expected workflow jobs");
  const steps = workflowSteps(workflow.jobs.rust);
  const processes = workflowSteps(workflow.jobs["browser-process"]);
  const build = steps.find(step => step.name === "Build the standard Browser guest once");
  const exporter = steps.find(step => step.name === "Export the validated standard Browser and tools guests");
  const upload = steps.find(step => record(step.with) && step.with.name === "browser-program");
  if (!build || !exporter || !upload) throw new Error("Missing Browser producer or exporter");
  expect(build.run).toBe('source env.sh\nBROWSER_CARGO_TARGET_DIR="$CARGO_TARGET_DIR" JOBS=2 bash scripts/build-bun-browser.sh\n');
  expect(text.match(/bash scripts\/build-bun-browser\.sh/g)).toHaveLength(1);
  expect(text).not.toContain("source-cache-browser");
  const recipe = await Bun.file(new URL("./build-bun-browser.sh", import.meta.url)).text();
  expect(recipe).toContain('guest-build-receipt.ts" inputs browser');
  expect(recipe).toContain('"$GUEST_CARGO" build --locked');
  expect(recipe).toContain("--features engine-host,bun-transpiler,bun-build");
  expect(recipe).toContain("wasm-opt -O2 -g --strip-dwarf");
  expect(recipe).toContain('guest-build-receipt.ts" write "$root/dist/bun-browser.wasm"');
  const native = steps.findIndex(step => step.name === "Blocking native fixture checks");
  expect(native).toBeGreaterThan(steps.indexOf(build));
  for (const name of ["Blocking native fixture checks", "Build the single tools fixture in the existing native target", "Blocking Web guest cases (QuickJS and host engine)", "Blocking Web guest case (JSC)"]) expect(steps.indexOf(exporter)).toBeGreaterThan(steps.findIndex(step => step.name === name));
  expect(exporter).toEqual({ name: "Export the validated standard Browser and tools guests", run: 'source env.sh\nbun scripts/ci-browser-program.ts export "$RUNNER_TEMP/browser-program"\n' });
  expect(upload).toEqual({ uses: "actions/upload-artifact@v4", "timeout-minutes": 5, with: { name: "browser-program", path: "${{ runner.temp }}/browser-program/", "if-no-files-found": "error", "retention-days": 1 } });
  expect(steps.indexOf(upload)).toBe(steps.indexOf(exporter) + 1);
  const sourceCache = processes.find(step => step.name === "Real Bun source cache in one Waffle browser runtime");
  const transfer = processes.find(step => step.name === "Native Wasm module and shared-memory worker transfer");
  if (!sourceCache || !record(sourceCache.env) || !transfer || !record(transfer.env)) throw new Error("Missing Browser regression consumers");
  expect(sourceCache.env.BUN_WASM_RUNTIME_PROC_ARTIFACT).toBe("${{ github.workspace }}/dist/browser-program/bun-browser.wasm");
  expect(sourceCache.env.BUN_WASM_RUNTIME_PROC_SCENARIO).toBe("source-cache");
  expect(sourceCache.run).toContain("bun ../scripts/ci-browser-program.ts verify ../dist/browser-program");
  expect(sourceCache.run).toContain("run-with-timeout.mts 300 bun tests/bun-runtime-proc-browser.ts");
  expect(transfer.env.BUN_WASM_TRANSFER_ARTIFACT).toBe(sourceCache.env.BUN_WASM_RUNTIME_PROC_ARTIFACT);
  expect(transfer.run).toContain("run-with-timeout.mts 120 bun tests/browser-wasm-transfer.ts");
  for (const path of ["scripts/build-bun-browser.sh", "scripts/ci-browser-program.ts", "scripts/ci-program-delivery.ts"]) expect(needsRust([path])).toBe(true);
  expect(discoverChecks().filter(check => check.path === "scripts/ci-browser-program.test.ts")).toEqual([{ owner: "quality", path: "scripts/ci-browser-program.test.ts", localRuntime: false, batch: "default" }]);
});
