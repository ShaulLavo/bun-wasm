import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Addon, configuredManifest, object } from "./config.ts";

async function sourceModule(path: string) {
  const module: unknown = await import(pathToFileURL(path).href);
  return object(module);
}

function template(module: Record<string, unknown>, name: string, args: unknown[]): string {
  const emit = module[name];
  if (typeof emit !== "function") throw new Error(`Missing pinned template: ${name}`);
  const result: unknown = emit(...args);
  if (typeof result !== "string") throw new Error(`Invalid template result: ${name}`);
  return result;
}

// Source-only adaptation of CLI 3.2.0 Builder.writeWasiBinding. The original
// source and export list are pinned, and the default outputs must match release.
export async function emitAddon(options: {
  generator: string; source: string; stage: string; addon: Addon; maintained: boolean;
}) {
  const { generator, source, stage, addon, maintained } = options;
  const original: unknown = JSON.parse(await readFile(join(source, `napi/${addon.addon}/package.json`), "utf8"));
  const manifest = configuredManifest(original, maintained);
  const napi = object(manifest.napi);
  const wasm = object(napi.wasm);
  const browserOptions = object(wasm.browser);
  const binaryName = napi.binaryName;
  const packageName = napi.packageName;
  if (typeof binaryName !== "string" || typeof packageName !== "string") throw new Error("Invalid addon identity");
  const loaders = await sourceModule(join(generator, "src/api/templates/load-wasi-template.ts"));
  const workers = await sourceModule(join(generator, "src/api/templates/wasi-worker-template.ts"));
  const output = join(stage, "src-js");
  await mkdir(output, { recursive: true });
  await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const binary = `${binaryName}.wasm32-wasi`;
  const cjs = template(loaders, "createWasiBinding", [binary, packageName, wasm.initialMemory, wasm.maximumMemory]);
  const browser = template(loaders, "createWasiBrowserBinding", [binary, wasm.initialMemory, wasm.maximumMemory, browserOptions.fs, browserOptions.asyncInit, browserOptions.buffer]);
  await writeFile(join(output, `${binaryName}.wasi.cjs`), cjs + cjsExports(addon.exports));
  await writeFile(join(output, `${binaryName}.wasi-browser.js`), browser + browserExports(addon.exports));
  if (typeof workers.WASI_WORKER_TEMPLATE !== "string") throw new Error("Missing Node worker template");
  await writeFile(join(output, "wasi-worker.mjs"), workers.WASI_WORKER_TEMPLATE);
  await writeFile(join(output, "wasi-worker-browser.mjs"), template(workers, "createWasiBrowserWorkerBinding", [browserOptions.fs ?? false]));
  await writeFile(join(output, "browser.js"), `export * from '${packageName}-wasm32-wasi'\n`);
  return { manifest, output };
}

function cjsExports(exports: readonly string[]) {
  return "module.exports = __napiModule.exports\n" + exports.map(ident => `module.exports.${ident} = __napiModule.exports.${ident}`).join("\n") + "\n";
}

function browserExports(exports: readonly string[]) {
  return "export default __napiModule.exports\n" + exports.map(ident => `export const ${ident} = __napiModule.exports.${ident}`).join("\n") + "\n";
}

export async function collectArtifacts(dependencies: string, stage: string) {
  const cli = await sourceModule(join(dependencies, "node_modules/@napi-rs/cli/dist/index.js"));
  if (typeof cli.NapiCli !== "function") throw new Error("Missing pinned NapiCli");
  const instance: unknown = Reflect.construct(cli.NapiCli, []);
  const collector = object(instance).artifacts;
  if (typeof collector !== "function") throw new Error("Missing normal artifact collector");
  await collector({ cwd: stage, outputDir: "src-js", buildOutputDir: join(stage, "src-js"), npmDir: "npm" });
}
