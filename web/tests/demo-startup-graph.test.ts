import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { buildBrowserEntries, resolveRuntimePackage } from "../../scripts/browser-build";
import { checkLazyProcessService, initialJavaScript } from "../../scripts/runtime-size";

for (const app of ["web", "sandbox"]) test(`${app} keeps Bun execution lazy alongside its startup shell contract`, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "bun-wasm-demo-startup-"));
  const root = resolve(import.meta.dir, "../..");
  const entry = resolve(root, app, "src/main.ts");
  try {
    const result = await buildBrowserEntries([entry, resolve(root, "web/src/worker.ts"), resolve(root, "web/src/fs-worker.ts")], scratch, { runtimeWorker: true });
    const outputs = result.metafile!.outputs;
    const main = Object.keys(outputs).find(path => path.endsWith("/main.js"));
    expect(main).toBeDefined();
    const sources = (keys: readonly string[]) => keys.flatMap(key => Object.entries(outputs[key]!.inputs)
      .filter(([, input]) => input.bytesInOutput > 0).map(([path]) => resolve(path)));
    const eagerKeys = initialJavaScript(outputs, [main!]);
    const eager = sources(eagerKeys);
    checkLazyProcessService(eager, resolveRuntimePackage(entry));
    for (const file of ["runner.ts", "bun-launcher.ts", "subprocess-broker.ts", "bun-executor.ts"]) {
      expect(eager.some(path => path.endsWith(`/web/src/${file}`) || path === `web/src/${file}`)).toBe(false);
    }
    expect(eager.some(path => path.endsWith("/engine-loader.ts"))).toBe(true);
    for (const suffix of ["/proc/supervisor.ts", "/proc/registry.ts", "/browser/process-broker.ts", "/proc/command-runner.ts", "/proc/command-stdio.ts"]) {
      expect(eager.some(path => path.endsWith(suffix))).toBe(false);
      expect(Object.keys(result.metafile!.inputs).some(path => path.endsWith(suffix))).toBe(true);
    }
    const commandRoots = eagerKeys.flatMap(key => outputs[key]!.imports
      .filter(imported => imported.kind === "dynamic-import")
      .map(imported => imported.path in outputs ? imported.path : posix.join(dirname(key), imported.path)));
    expect(commandRoots.length).toBeGreaterThan(0);
    const command = sources(initialJavaScript(outputs, commandRoots));
    const execution = app === "web" ? "bun-launcher.ts" : "runner.ts";
    expect(command.some(path => path.endsWith(`/web/src/${execution}`))).toBe(true);
    expect(eager.some(path => path.endsWith("/bash-web/src/runtime/shell-host.ts"))).toBe(false);
    if (app === "web") expect(command.some(path => path.endsWith("/bash-web/src/runtime/shell-host.ts"))).toBe(true);
    if (app === "web") {
      const promptOutputs = Object.keys(outputs).filter(path => Object.keys(outputs[path]!.inputs).some(input => resolve(input).endsWith("/bash-web/src/prompt/index.ts")));
      expect(promptOutputs.length).toBeGreaterThan(0);
      const promptStatic = sources(initialJavaScript(outputs, promptOutputs));
      expect(promptStatic.some(path => path.endsWith("/bash-web/src/prompt/index.ts"))).toBe(true);
      for (const suffix of ["/bash-web/src/prompt/sources/status.ts", "/bash-web/src/prompt/sources/objects.ts", "/bash-web/src/prompt/config/file.ts"]) {
        expect(eager.some(path => path.endsWith(suffix))).toBe(false);
        expect(promptStatic.some(path => path.endsWith(suffix))).toBe(false);
        expect(Object.keys(result.metafile!.inputs).some(path => resolve(path).endsWith(suffix))).toBe(true);
      }
      const playground = await Bun.file(resolve(root, "web/src/playground/playground.ts")).text();
      expect(playground).toContain('this.params.get("prompt") === "off" ? undefined : import("bash-web/prompt")');
      expect(playground).toContain('PS1: "$ "');
      expect(playground).toContain("versions: HOST_VERSIONS");
    }
    if (app === "web") expect(Object.keys(result.metafile!.inputs).some(path => resolve(path).endsWith("/web/src/runner.ts"))).toBe(false);
    const filesystem = Object.keys(outputs).find(path => path.endsWith("/fs-worker.js"));
    expect(filesystem).toBeDefined();
    const filesystemInputs = sources(initialJavaScript(outputs, [filesystem!]));
    expect(filesystemInputs.some(path => /\/(?:engine-loader|runner|bun-launcher|subprocess-broker|bun-executor)\.ts$/.test(path))).toBe(false);
    expect(filesystemInputs.some(path => path.includes("@xterm/") || path.includes("@codemirror/"))).toBe(false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
