import { baseProgramAssets } from "./base-program-build";
import { relative, join, resolve, isAbsolute, dirname } from "node:path";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { pinnedBashWeb, verifiedGuests } from "./bash-web-guests";

const runtimeName = "waffle";

/** Resolve only the consuming installation, without assuming checkout/cache directory names. */
export function resolveRuntimePackage(consumerEntry: string) {
  const path = (createRequire(resolve(consumerEntry)).resolve.paths(runtimeName) ?? [])
    .map(directory => join(directory, runtimeName)).find(directory => existsSync(join(directory, "package.json")));
  if (!path) throw new Error(`The consuming app must install ${runtimeName}`);
  // Bun file: installs can symlink each file rather than the package directory.
  const physical = dirname(realpathSync(join(path, "package.json")));
  const metadata = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  function inside(root: string, candidate: string): string | undefined {
    const rel = relative(root, candidate);
    return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? undefined : rel.replaceAll("\\", "/");
  }
  function select(value: unknown): string | null | undefined {
    if (typeof value === "string" || value === null) return value;
    if (typeof value !== "object") return undefined;
    for (const [condition, target] of Object.entries(value)) {
      if (["browser", "bun", "import", "default"].includes(condition)) {
        const selected = select(target);
        if (selected !== undefined) return selected;
      }
    }
  }
  return {
    path, physical, metadata,
    source(specifier: string): string {
      if (specifier !== runtimeName && !specifier.startsWith(runtimeName + "/")) throw new Error(`Not a runtime import: ${specifier}`);
      const key = specifier === runtimeName ? "." : "." + specifier.slice(runtimeName.length);
      const target = select(metadata.exports?.[key]);
      if (!target) throw new Error(`${specifier} is not exported for the browser`);
      const output = resolve(path, target);
      if (!target.startsWith("./") || inside(path, output) === undefined) throw new Error(`Invalid runtime export: ${target}`);
      if (!existsSync(output)) throw new Error(`Missing runtime export: ${output}`);
      const physicalOutput = realpathSync(output);
      if (inside(physical, physicalOutput) === undefined) throw new Error(`Runtime export escapes installed package: ${target}`);
      return output;
    },
    relativeSource(specifier: string, importer: string): string | undefined {
      if (inside(path, importer) === undefined && inside(physical, importer) === undefined) return;
      const resolved = Bun.resolveSync(specifier, dirname(importer));
      const input = inside(path, resolved) ?? inside(physical, resolved);
      if (input === undefined) throw new Error(`Runtime relative import escapes installed package: ${specifier}`);
      // Keep every module under the same consumer alias: physical cache names may
      // contain '..', which Bun rejects in file-namespace plugin result paths.
      return join(path, input);
    },
    relativeInput(input: string, base = process.cwd()): string | undefined {
      const absolute = resolve(base, input);
      return inside(path, absolute) ?? inside(physical, absolute);
    },
  };
}

export type RuntimePackage = ReturnType<typeof resolveRuntimePackage>;

async function publishNetworkAsset(result: Bun.BuildOutput, runtime: RuntimePackage, outdir: string): Promise<void> {
  if (!result.success || !result.metafile) return;
  const directories = new Set<string>();
  for (const [path, output] of Object.entries(result.metafile.outputs)) {
    if (!path.endsWith(".js")) continue;
    const hasLoader = Object.entries(output.inputs).some(([input, contribution]) => contribution.bytesInOutput > 0 && runtime.relativeInput(input) === "browser/net/module.ts");
    if (hasLoader) directories.add(dirname(resolve(outdir, path)));
  }
  if (!directories.size) return;
  // Waffle prepare owns source-input verification. Keep its URL and artifact intact.
  const directory = dirname(runtime.source("waffle/network"));
  const bytes = await Bun.file(join(directory, "network.wasm")).arrayBuffer();
  const checksum = await Bun.file(join(directory, "network.sha256")).text();
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== checksum) throw new Error("Installed Waffle network artifact checksum mismatch");
  for (const destination of directories) await Bun.write(join(destination, "network.wasm"), bytes);
}

/** Shared page/worker build settings. The consuming app's main entry must be first. */
export function browserBuildConfig(entrypoints: string[], outdir: string, options: { splitting?: boolean; runtimeWorker?: boolean } = {}): Parameters<typeof Bun.build>[0] {
  const main = entrypoints[0];
  if (!main) throw new Error("Browser build needs the consuming application's main entry");
  let runtimePackage: RuntimePackage | undefined;
  if (options.runtimeWorker) {
    runtimePackage = resolveRuntimePackage(main);
    entrypoints = entrypoints.concat([runtimePackage.source("waffle/browser/preview1-worker")]);
  }
  return {
    entrypoints, outdir, target: "browser", format: "esm",
    splitting: options.splitting ?? true,
    minify: true, sourcemap: "linked", metafile: true,
    naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    // The pages' components use Remix's JSX. Bun 1.4.4 drops tsconfig's jsxImportSource once a
    // plugin resolves relative imports (the runtime plugin below), so the build states it too.
    jsx: { runtime: "automatic", importSource: "@remix-run/component" },
    plugins: [baseProgramAssets(main), {
      name: "consumer-runtime-package",
      setup(build) {
        // Shared web sources still use the app's installation. Explicit package
        // exports enforce the boundary; dotted Git-cache names are opaque paths.
        build.onResolve({ filter: /^waffle(?:\/|$)/ }, ({ path }) => {
          runtimePackage ??= resolveRuntimePackage(main);
          return { path: runtimePackage.source(path) };
        });
        build.onResolve({ filter: /^\.\.?\// }, ({ path, importer }) => {
          if (!runtimePackage) return;
          const resolved = runtimePackage.relativeSource(path, importer);
          if (resolved) return { path: resolved };
        });
        build.onEnd(result => runtimePackage && build.config.outdir ? publishNetworkAsset(result, runtimePackage, build.config.outdir) : undefined);
      },
    }],
  };
}

async function checked(config: Parameters<typeof Bun.build>[0]) {
  const result = await Bun.build(config);
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  return result;
}

const workerAnchor = "bunwasm-worker-anchor";
function anchorPlugin(entry: string): Bun.BunPlugin {
  return {
    name: workerAnchor,
    setup(build) {
      build.onResolve({ filter: /^bunwasm-worker-anchor$/ }, () => ({ path: workerAnchor, namespace: workerAnchor }));
      build.onLoad({ filter: /.*/, namespace: workerAnchor }, () => ({ contents: `import ${JSON.stringify(entry)};`, loader: "ts" }));
    },
  };
}

function importsWorkerEntry(result: Awaited<ReturnType<typeof checked>>, outdir: string): boolean {
  const entry = result.outputs.find(output => output.kind === "entry-point");
  if (!entry) throw new Error("Browser realm has no entry output");
  const outputs = result.metafile!.outputs;
  return Object.entries(outputs).some(([path, output]) => output.imports.some(imported => {
    const dependency = imported.path in outputs ? imported.path : join(dirname(path), imported.path);
    return resolve(outdir, dependency) === entry.path;
  }));
}

async function buildRealm(config: Parameters<typeof Bun.build>[0], entry: string, worker: boolean) {
  const result = await checked({ ...config, entrypoints: [entry] });
  if (!worker || !importsWorkerEntry(result, config.outdir!)) return result;
  // WebKit can evaluate a module-worker entry again when a lazy chunk imports it.
  // A second build root moves those exports into ordinary, cached modules instead.
  const anchored = await checked({ ...config, entrypoints: [entry, workerAnchor], plugins: (config.plugins ?? []).concat([anchorPlugin(entry)]) });
  const auxiliary = anchored.outputs.filter(output => [workerAnchor + ".js", workerAnchor + ".js.map"].includes(relative(config.outdir!, output.path)));
  await Promise.all(auxiliary.map(output => unlink(output.path)));
  const outputs = Object.fromEntries(Object.entries(anchored.metafile!.outputs).filter(([path]) => !auxiliary.some(output => resolve(config.outdir!, path) === output.path)));
  const inputs = Object.fromEntries(Object.entries(anchored.metafile!.inputs).filter(([path]) => !path.endsWith(workerAnchor)));
  return { ...anchored, outputs: anchored.outputs.filter(output => !auxiliary.includes(output)), metafile: { ...anchored.metafile!, outputs, inputs } };
}

export async function buildBrowserEntries(entrypoints: string[], outdir: string, options: { runtimeWorker?: boolean } = {}) {
  // Each worker has its own module cache. A multi-entry build hoists the whole shared
  // core/filesystem closure into every realm, even when that realm needs only a subset.
  // Bundle each realm separately so its initial graph can be tree-shaken independently.
  const config = browserBuildConfig(entrypoints, outdir, options);
  const builds = [];
  for (const [index, entry] of config.entrypoints!.entries()) builds.push(await buildRealm(config, entry, index > 0));
  const first = builds[0];
  if (!first) throw new Error("Browser build needs an entry");
  const outputs = new Map<string, typeof first.outputs[number]>();
  for (const output of builds.flatMap(build => build.outputs)) {
    const previous = outputs.get(output.path);
    if (previous && await previous.text() !== await output.text()) throw new Error(`Conflicting browser output: ${output.path}`);
    outputs.set(output.path, output);
  }
  const metafile: NonNullable<typeof first.metafile> = {
    ...first.metafile!,
    inputs: Object.assign({}, ...builds.map(build => build.metafile!.inputs)),
    outputs: Object.assign({}, ...builds.map(build => build.metafile!.outputs)),
  };
  const result = { ...first, outputs: Array.from(outputs.values()), metafile };
  // Safari can fetch the bootstrap directly, before service-worker interception is ready.
  const worker = result.outputs.find((output) => relative(outdir, output.path) === "worker.js");
  if (!worker) throw new Error("Browser build is missing worker.js");
  // Relative imports resolve under __bunwasm/ for the scoped worker. Mirror every
  // chunk (including dynamic chunks and their maps), not just today's static closure.
  for (const output of result.outputs) {
    const path = relative(outdir, output.path);
    if (!(scopedSiblings.has(path.replace(/\.map$/, "")) || path.startsWith("chunks/"))) continue;
    await Bun.write(join(outdir, "__bunwasm", path), output);
    const network = Bun.file(join(dirname(output.path), "network.wasm"));
    if (path.endsWith(".js") && await network.exists()) await Bun.write(join(outdir, "__bunwasm", dirname(path), "network.wasm"), network);
  }
  return result;
}

// Workers a scoped Bun worker reaches as siblings of its own URL (siblingWorkerUrl).
const scopedSiblings = new Set(["worker.js", "fs-worker.js", "preview1-worker.js", "notification-worker.js"]);

/** Keep service workers standalone classic scripts for Safari. Never split this build. */
export function buildClassicWorker(entrypoint: string, outdir: string, define?: Record<string, string>, consumerEntry = entrypoint) {
  const { plugins } = browserBuildConfig([consumerEntry], outdir);
  return checked({ entrypoints: [entrypoint], outdir, define, plugins, target: "browser", format: "iife", minify: true, metafile: true, naming: "[name].[ext]" });
}

/**
 * bash-web's shell at /bin/sh and /bin/bash for package scripts, Bun.$ and bun exec, and its env
 * utility for `#!/usr/bin/env` bins. The worker is bundled from the consumer's installed bash-web.
 * bash-web publishes no prebuilt guests, so they come from scripts/build-bash-web-shell.sh in
 * BASH_WEB_GUESTS_DIR (default ../dist), checked against its receipt and the consumer's bash-web pin.
 * A stale or partial set always fails. A missing set fails when BASH_WEB_GUESTS=required (site
 * deploys); test builds without guests only skip the shell. bash-web's loaders fetch the guests
 * themselves, so they ship raw.
 */
export async function buildShellAssets(consumer: string, outdir: string) {
  const worker = await Bun.build({ entrypoints: [join(consumer, "node_modules/bash-web/src/runtime/worker.ts")], outdir, naming: "shell-worker.js", target: "browser", format: "esm", minify: true });
  if (!worker.success) throw new AggregateError(worker.logs, "bash-web shell worker build failed");
  const dist = resolve(consumer, process.env.BASH_WEB_GUESTS_DIR ?? "../dist");
  const guests = verifiedGuests(dist, pinnedBashWeb(consumer));
  if (guests) {
    for (const { program, path } of guests) await Bun.write(join(outdir, "programs", program), Bun.file(path));
    return;
  }
  const missing = `no bash-web guests in ${dist}; run scripts/build-bash-web-shell.sh`;
  if (process.env.BASH_WEB_GUESTS === "required") throw new Error(missing);
  console.warn(`${missing}. Package scripts, Bun.$, bun exec and #!/usr/bin/env bins will not run.`);
}
