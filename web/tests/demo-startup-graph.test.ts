import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBrowserEntries } from "../../scripts/browser-build";
import { initialJavaScript } from "../../scripts/runtime-size";

for (const app of ["web", "sandbox"]) test(`${app} loads Bun execution only on the first command`, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-demo-startup-"));
  const root = resolve(import.meta.dir, "../..");
  const entry = resolve(root, app, "src/main.ts");
  try {
    const result = await buildBrowserEntries([entry, resolve(root, "web/src/worker.ts"), resolve(root, "web/src/fs-worker.ts")], scratch, { runtimeWorker: true });
    const outputs = result.metafile!.outputs;
    const main = Object.keys(outputs).find(path => path.endsWith("/main.js"));
    expect(main).toBeDefined();
    const eager = initialJavaScript(outputs, [main!]).flatMap(path => Object.keys(outputs[path]!.inputs));
    for (const file of ["runner.ts", "bun-launcher.ts", "subprocess-broker.ts", "bun-executor.ts"]) {
      expect(eager.some(path => path.endsWith(`/web/src/${file}`) || path === `web/src/${file}`)).toBe(false);
    }
    expect(eager.some(path => path.endsWith("/engine-loader.ts"))).toBe(true);
    for (const suffix of ["/proc/supervisor.ts", "/proc/registry.ts", "/browser/process-broker.ts"]) {
      expect(eager.some(path => path.endsWith(suffix))).toBe(false);
      expect(Object.keys(result.metafile!.inputs).some(path => path.endsWith(suffix))).toBe(true);
    }
    expect(Object.keys(result.metafile!.inputs).some(path => path.endsWith("/runner.ts"))).toBe(true);
    const filesystem = Object.keys(outputs).find(path => path.endsWith("/fs-worker.js"));
    expect(filesystem).toBeDefined();
    const filesystemInputs = initialJavaScript(outputs, [filesystem!]).flatMap(path => Object.keys(outputs[path]!.inputs));
    expect(filesystemInputs.some(path => path.endsWith("/engine-loader.ts") || path.endsWith("/runner.ts"))).toBe(false);
    expect(filesystemInputs.some(path => path.includes("@xterm/") || path.includes("@codemirror/"))).toBe(false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
