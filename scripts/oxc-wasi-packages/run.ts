import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import inputs from "./inputs.lock.json" with { type: "json" };
import { acquire, digest, verifyFiles } from "./acquire.ts";
import { addons, packageManifest, policy, variantVersion, object, strings } from "./config.ts";
import { collectArtifacts, emitAddon } from "./emit.ts";

async function bundleParser(dependencies: string, source: string, stage: string) {
  const module: unknown = await import(pathToFileURL(join(dependencies, "node_modules/esbuild/lib/main.js")).href);
  const build = object(module).build;
  if (typeof build !== "function") throw new Error("Missing esbuild");
  for (const file of ["wasm.js", "wrap.js"]) await copyFile(join(source, `napi/parser/src-js/${file}`), join(stage, "src-js", file));
  await linkBundleDependencies(dependencies, stage);
  await build({
    absWorkingDir: stage,
    entryPoints: ["./src-js/wasm.js"],
    outfile: "npm/wasm32-wasi/browser-bundle.js",
    alias: {
      "@oxc-parser/binding-wasm32-wasi": "./src-js/parser.wasi-browser.js",
      "@napi-rs/wasm-runtime": join(stage, "node_modules/@napi-rs/wasm-runtime/runtime.js"),
    },
    preserveSymlinks: true,
    bundle: true, platform: "browser", format: "esm", logLevel: "silent",
  });
}

async function linkBundleDependencies(dependencies: string, stage: string) {
  const packages = ["@emnapi/core", "@emnapi/runtime", "@emnapi/wasi-threads", "@tybys/wasm-util", "tslib", "@napi-rs/wasm-runtime"];
  for (const name of packages) {
    const destination = join(stage, "node_modules", name);
    const source = name === "@napi-rs/wasm-runtime" ? "oxc-bundle-runtime" : name;
    await mkdir(dirname(destination), { recursive: true });
    await symlink(join(dependencies, "node_modules", source), destination, "dir");
  }
}

async function pack(directory: string, destination: string, addon: string) {
  // npm pack is the normal package-file closure, not a hand-built delivery tar.
  const result: unknown = JSON.parse(execFileSync("npm", ["pack", directory, "--ignore-scripts", "--json", "--pack-destination", destination], { encoding: "utf8", env: { ...process.env, npm_config_cache: process.env.npm_config_cache ?? join(destination, "..", "npm-cache") } }));
  if (!Array.isArray(result)) throw new Error("Missing npm pack result");
  const filename = object(result[0]).filename;
  if (typeof filename !== "string") throw new Error("Missing packed filename");
  const bytes = await readFile(join(destination, filename));
  return { addon, filename, sha256: digest(bytes), integrity: `sha512-${digest(bytes, "sha512", "base64")}`, pack: result[0] };
}

export async function generate(work: string, dependencies: string) {
  const { source, generator } = await acquire(work);
  const recipe = await recipeIdentity();
  const results = [];
  const output = join(work, "packed");
  await mkdir(output);
  await verifyDependencyVersions(dependencies);
  for (const addon of addons) {
    const original = join(work, addon.addon, "package");
    await generateOne({ work, dependencies, source, generator, recipe, addon, original, maintained: false });
    const directory = await generateOne({ work, dependencies, source, generator, recipe, addon, original, maintained: true });
    results.push(await pack(directory, output, addon.addon));
  }
  await writeFile(join(output, "artifacts.json"), JSON.stringify({ source: inputs.source.commit, generator: inputs.generator, recipe, policy, version: variantVersion, results }, null, 2) + "\n");
  return results;
}

type Generation = Awaited<ReturnType<typeof acquire>> & {
  work: string; dependencies: string; recipe: Awaited<ReturnType<typeof recipeIdentity>>; addon: (typeof addons)[number]; original: string; maintained: boolean;
};

async function generateOne(options: Generation) {
  const { work, dependencies, source, generator, recipe, addon, original, maintained } = options;
  const stage = join(work, maintained ? "maintained" : "baseline", addon.addon);
  const { output } = await emitAddon({ generator, source, stage, addon, maintained });
  const packageDirectory = join(stage, "npm/wasm32-wasi");
  await mkdir(packageDirectory, { recursive: true });
  const manifest: unknown = JSON.parse(await readFile(join(original, "package.json"), "utf8"));
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify(packageManifest(manifest, maintained), null, 2) + "\n");
  await copyFile(join(original, `${addon.addon}.wasm32-wasi.wasm`), join(output, `${addon.addon}.wasm32-wasi.wasm`));
  await copyFile(join(original, "README.md"), join(packageDirectory, "README.md"));
  await collectArtifacts(dependencies, stage);
  if (!maintained) await verifyBaseline(packageDirectory, addon);
  if (addon.addon === "parser") await bundleParser(dependencies, source, stage);
  if (maintained) await writeFile(join(packageDirectory, "bun-wasm-variant.json"), JSON.stringify({
    classification: "maintained source-template emitter adaptation, not stock napi build",
    name: addon.name, version: variantVersion, upstreamVersion: addon.version,
    source: inputs.source, generator: inputs.generator, recipe, policy: { ...policy, shared: true },
    wasmSha256: addon.wasmSha256, exportIdentifiers: addon.exports,
    runtime: { node: "1.0.6", browserBundle: "1.0.5", core: "1.5.0", threads: "1.1.0" },
  }, null, 2) + "\n");
  await checkClosure(packageDirectory);
  await verifyFiles(original, addon.files);
  return packageDirectory;
}

async function recipeIdentity() {
  const files = ["acquire.ts", "config.ts", "emit.ts", "run.ts", "inputs.lock.json", "package.json", "bun.lock"];
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = digest(await readFile(fileURLToPath(new URL(file, import.meta.url))));
  return { name: "bun-wasm/scripts/oxc-wasi-packages", files: hashes };
}

async function verifyBaseline(directory: string, addon: (typeof addons)[number]) {
  const files = Object.fromEntries(Object.entries(addon.files).filter(([path]) => !["package.json", "browser-bundle.js"].includes(path)));
  await verifyFiles(directory, files);
}

export async function checkClosure(directory: string) {
  const manifest = object(JSON.parse(await readFile(join(directory, "package.json"), "utf8")));
  for (const path of strings(manifest.files)) await readFile(join(directory, path));
  const unexpected = (await readdir(directory)).filter(file => !strings(manifest.files).concat(["package.json", "README.md"]).includes(file));
  if (unexpected.length) throw new Error(`Unexpected packed inputs: ${unexpected.join(", ")}`);
}

async function verifyDependencyVersions(directory: string) {
  await verifyFiles(join(directory, "node_modules/@napi-rs/cli"), inputs.generator.files);
  const versions = { "@napi-rs/cli": "3.2.0", "esbuild": "0.25.10", "@napi-rs/wasm-runtime": "1.0.6", "oxc-bundle-runtime": "1.0.5", "@emnapi/core": "1.5.0", "@emnapi/runtime": "1.5.0", "@emnapi/wasi-threads": "1.1.0", "@tybys/wasm-util": "0.10.1", "tslib": "2.8.1" };
  for (const [name, expected] of Object.entries(versions)) {
    const manifest = object(JSON.parse(await readFile(join(directory, "node_modules", name, "package.json"), "utf8")));
    if (manifest.version !== expected) throw new Error(`Unexpected ${name} version: ${manifest.version}`);
  }
}

if (import.meta.main) {
  const [work, dependencies] = process.argv.slice(2);
  if (!work || !dependencies) throw new Error("Usage: bun run.ts <new-work-directory> <isolated-dependencies-directory>");
  process.stdout.write(JSON.stringify(await generate(resolve(work), resolve(dependencies)), null, 2) + "\n");
}
