import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBrowserEntries, resolveRuntimePackage } from "../../scripts/browser-build";
import { initialJavaScript } from "../../scripts/runtime-size";

test("ordinary Bun worker and page startup do not eagerly load generic ownership adapters", async () => {
  const base = process.env.RUNNER_TEMP ?? process.env.SCRATCH ?? (existsSync("/work/tmp") ? "/work/tmp" : tmpdir());
  const scratch = await mkdtemp(join(base, "bun-wasm-runtime-ownership-"));
  try {
    const entry = new URL("../src/runner.ts", import.meta.url).pathname;
    const build = await buildBrowserEntries([entry, new URL("../src/worker.ts", import.meta.url).pathname], join(scratch, "dist"), { runtimeWorker: true });
    const outputs = build.metafile!.outputs;
    const roots = Object.keys(outputs).filter(path => path.endsWith("/runner.js") || path.endsWith("/worker.js"));
    expect(roots).toHaveLength(2);
    const initial = initialJavaScript(outputs, roots);
    const runtime = resolveRuntimePackage(entry);
    const inputs = initial.flatMap(path => Object.keys(outputs[path]!.inputs));
    for (const name of ["worker-client", "worker-broker", "filesystem-codec", "pipes", "abi"]) {
      expect(inputs.some(path => runtime.relativeInput(path) === `proc/${name}.ts`)).toBe(false);
    }
    expect(inputs.some(path => runtime.relativeInput(path) === "browser/runtime-terminals.ts")).toBe(false);
    expect(Object.keys(build.metafile!.inputs).some(path => runtime.relativeInput(path) === "proc/worker-client.ts")).toBe(true);
    // Bun's old child-process transport is gone from every entry, initial or lazy.
    const everything = Object.keys(build.metafile!.inputs);
    for (const removed of ["web/src/subprocess.ts", "web/src/worker-pipes.ts"]) expect(everything.some(path => path.endsWith(removed))).toBe(false);
    const generic = Object.keys(outputs).find(path => path.endsWith("/preview1-worker.js"));
    expect(generic).toBeDefined();
    const genericInputs = initialJavaScript(outputs, [generic!]).flatMap(path => Object.keys(outputs[path]!.inputs));
    expect(genericInputs.every(path => runtime.relativeInput(path) !== undefined)).toBe(true);
    for (const path of ["preview1-worker.js", "preview1-worker.js.map"]) {
      expect(await Bun.file(join(scratch, "dist", "__bunwasm", path)).text()).toBe(await Bun.file(join(scratch, "dist", path)).text());
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
