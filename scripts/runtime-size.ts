// Artifact-free bundle gate. From the repository root: bun scripts/runtime-size.ts [--json]
// Standalone layer closures overlap: they are actionable import costs, not additive attribution.
import { posix, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { browserBuildConfig, resolveRuntimePackage, type RuntimePackage } from "./browser-build";
import { previewWebsocketScript } from "../web/preview-build";

type OutputGraph = Record<string, { imports: { path: string; kind: string; external?: boolean }[] }>;

/** Follow only statically imported JS, preserving asset URLs (not source-map inputs). */
export function initialJavaScript(outputs: OutputGraph, roots: readonly string[]): string[] {
  const seen = new Set<string>();
  function visit(path: string): void {
    if (seen.has(path)) return;
    const output = outputs[path];
    if (!output) throw new Error(`Missing initial JavaScript output: ${path}`);
    seen.add(path);
    for (const imported of output.imports) {
      if (imported.kind === "dynamic-import") continue;
      if (imported.external) throw new Error(`Unmeasured external initial import: ${imported.path}`);
      if (!imported.path.endsWith(".js")) continue;
      const dependency = imported.path in outputs ? imported.path : posix.normalize(posix.join(posix.dirname(path), imported.path));
      visit(dependency);
    }
  }
  for (const root of roots) visit(root);
  return Array.from(seen).sort();
}

// Waffle 0.0.67 adds descriptor reopening and publication checks: ~9,650 B gzip plus 334 B margin.
const CORE_BUDGET_KIB = 9.75;
export function checkCoreBudget(gzipBytes: number): void {
  const budget = CORE_BUDGET_KIB * 1024;
  if (gzipBytes > budget) throw new Error(`core exceeds ${budget} B gzip budget by ${gzipBytes - budget} B; inspect runtime/core imports and the layer report`);
}

/** Reservation/directory cells, signal control and typed startup values are eager, not the
 * supervisor, executable registry or worker service. Their bytes remain in the size totals. */
export function processServiceInputs(inputs: readonly string[], runtime: RuntimePackage): string[] {
  return inputs.filter(path => {
    const match = /^(?:dist\/)?proc\/(.+)\.(?:ts|js)$/.exec(runtime.relativeInput(path) ?? "");
    return match !== null && !["identity", "stub", "intrinsics", "intrinsics/core", "intrinsics/host", "errors", "control", "directory", "outcome", "start-errno", "start-failure", "wait-status", "signals", "types"].includes(match[1]!);
  });
}
export function checkLazyProcessService(inputs: readonly string[], runtime: RuntimePackage): void {
  const eager = processServiceInputs(inputs, runtime);
  if (eager.length) throw new Error(`process service is eager before first spawn: ${eager.join(", ")}`);
}
/** Bun supplies launch/engine policy; Waffle owns processes, signals and pipes. */
export function bunProcessAdapterInputs(inputs: readonly string[]): string[] {
  return inputs.filter(path => /(?:^|\/)web\/src\/(?:bun-executor|bun-launcher|subprocess-broker)\.ts$/.test(path));
}
/** Own Bun programs need only the tiny fatal-outcome check, never the load-time compiler. */
export function checkLazyInterruptRewriter(inputs: readonly string[], runtime: RuntimePackage): void {
  const eager = inputs.filter(path => {
    const match = /^(?:dist\/)?interrupt\/(.+)\.(?:ts|js)$/.exec(runtime.relativeInput(path) ?? "");
    return match !== null && match[1] !== "check";
  });
  if (eager.length) throw new Error(`interrupt rewriter is eager before third-party load: ${eager.join(", ")}`);
}

const root = resolve(import.meta.dir, "..");
const bytes = async (output: Blob) => {
  const buffer = Buffer.from(await output.arrayBuffer());
  return { minified: buffer.length, gzip: gzipSync(buffer, { level: 9 }).length };
};
const totals = (rows: readonly { minified: number; gzip: number }[]) => rows.reduce((sum, row) => ({ minified: sum.minified + row.minified, gzip: sum.gzip + row.gzip }), { minified: 0, gzip: 0 });

async function build(config: Parameters<typeof Bun.build>[0]) {
  // Bun's JS API writes when outdir is set; omitting it is the artifact-free mode.
  const { outdir: _outdir, ...inMemory } = config;
  const result = await Bun.build({ ...inMemory, metafile: true });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
  return result;
}

/** Bun attributes minified bytes per input; gzip is measured only for complete outputs. */
export function moduleContributions(
  outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>,
  runtime: RuntimePackage,
): { path: string; minified: number }[] {
  const contributions = new Map<string, number>();
  for (const [path, output] of Object.entries(outputs)) {
    if (!path.endsWith(".js")) continue;
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const name = runtime.relativeInput(input) ?? input;
      contributions.set(name, (contributions.get(name) ?? 0) + bytesInOutput);
    }
  }
  return Array.from(contributions, ([path, minified]) => ({ path, minified }))
    .sort((a, b) => b.minified - a.minified || a.path.localeCompare(b.path));
}

async function layer(name: string, entries: readonly string[], guideKiB: number) {
  const outdir = resolve(root, ".runtime-size", name);
  const runtime = resolveRuntimePackage(resolve(root, "web/src/main.ts"));
  const result = await build(browserBuildConfig(entries.map(path => path.startsWith("waffle") ? runtime.source(path) : resolve(root, path)), outdir));
  const files = await Promise.all(result.outputs.filter((output) => output.path.endsWith(".js")).map(async (output) => ({ path: posix.normalize(output.path), ...await bytes(output) })));
  const sizes = totals(files);
  const inputs = moduleContributions(result.metafile!.outputs, runtime);
  return { name, entries, ...sizes, guideGzip: guideKiB * 1024, files, inputs };
}

async function application(name: "web" | "sandbox", splitting: boolean, serviceWorker: { minified: number; gzip: number }) {
  const outdir = resolve(root, ".runtime-size", `${name}-${splitting ? "split" : "unsplit"}`);
  const result = await build(browserBuildConfig([resolve(root, name, "src/main.ts"), resolve(root, "web/src/worker.ts"), resolve(root, "web/src/fs-worker.ts")], outdir, { splitting, runtimeWorker: true }));
  const outputs = result.metafile!.outputs;
  const keyFor = (name: string) => {
    const key = Object.keys(outputs).find((path) => posix.normalize(path) === name);
    if (!key) throw new Error(`Missing ${name} in ${name} bundle metadata`);
    return key;
  };
  const fileFor = (key: string) => {
    const file = result.outputs.find((output) => resolve(output.path) === resolve(key));
    if (!file) throw new Error(`Missing built artifact ${key}`);
    return file;
  };
  const rowFor = async (key: string) => ({ path: posix.normalize(key), ...await bytes(fileFor(key)) });
  const main = initialJavaScript(outputs, [keyFor("main.js")]);
  const worker = initialJavaScript(outputs, [keyFor("worker.js")]);
  const initialKeys = Array.from(new Set(main.concat(worker, initialJavaScript(outputs, [keyFor("fs-worker.js")])))).sort();
  const logicalFiles = (await Promise.all(initialKeys.map(rowFor))).concat([{ path: "sw.js", ...serviceWorker }]);
  const logicalEntries = await Promise.all(["main.js", "worker.js", "fs-worker.js"].map(async (entry) => {
    const files = await Promise.all(initialJavaScript(outputs, [keyFor(entry)]).map(rowFor));
    return { entry, ...totals(files), files };
  }));
  // Root page and scoped worker resolve a shared chunk to different URLs, so both count.
  const downloadRows = (await Promise.all(main.map(rowFor))).concat(
    await Promise.all(worker.map(async (key) => { const row = await rowFor(key); return { ...row, path: `__bunwasm/${row.path}` }; })),
    await Promise.all(initialJavaScript(outputs, [keyFor("fs-worker.js")]).map(rowFor)),
    [{ path: "sw.js", ...serviceWorker }],
  );
  // Page and filesystem worker share root URLs; a cold URL downloads once, not once per importer.
  const initialDownloads = Array.from(new Map(downloadRows.map(row => [row.path, row])).values());
  const inputs = Array.from(new Set(initialKeys.flatMap((key) => Object.keys(outputs[key]!.inputs)))).sort();
  const runtime = resolveRuntimePackage(resolve(root, name, "src/main.ts"));
  const procInputs = processServiceInputs(inputs, runtime);
  const bunAdapterInputs = bunProcessAdapterInputs(inputs);
  if (splitting) {
    checkLazyProcessService(inputs, runtime);
    checkLazyInterruptRewriter(inputs, runtime);
  }
  return {
    splitting, logicalEntries: logicalEntries.concat([{ entry: "sw.js", ...serviceWorker, files: [{ path: "sw.js", ...serviceWorker }] }]),
    logicalJavaScript: { ...totals(logicalFiles), files: logicalFiles },
    bunLightInitialJavaScript: { ...totals(initialDownloads), files: initialDownloads },
    // Two registrations use the same classic script today. Cold browsers can fetch it twice.
    serviceWorkerRegistrations: [{ script: "sw.js", scope: "__bunwasm/" }, { script: "sw.js", scope: "__preview/" }],
    coldJavaScriptWithBothRegistrations: totals(initialDownloads.concat([{ path: "sw.js (second registration)", ...serviceWorker }])),
    otherBunLightDownloads: ["index.html", "main.css", "bun-browser.wasm.gz"].concat(name === "sandbox" ? ["template.json"] : []),
    excludedDownloads: ["bun.wasm.gz", "bun-jsc.wasm.gz", "*.map"],
    proc: { eager: procInputs.length > 0, inputs: procInputs, bunAdapterInputs,
      note: "Waffle owns the runtime_proc service and process-owned pipes; Bun contributes only launch and engine policy. Static service imports remain measured and gated separately from those Bun adapters." },
  };
}

export async function runtimeSizeReport() {
  const previewSocketScript = await previewWebsocketScript();
  const layers = await Promise.all([
    layer("core", ["waffle/core"], CORE_BUDGET_KIB),
    layer("fs", ["waffle/fs"], 6),
    layer("net", ["waffle/browser/net/host", "waffle/browser/net/helper", "waffle/browser/preview"], 14),
    layer("proc", ["waffle/proc"], 8),
    layer("proc-stub", ["waffle/proc/stub", "waffle/proc/outcome"], 1),
  ]);
  // This separately linked preview client uses a source-wrapper plugin; measure its real build.
  const net = layers.find((layer) => layer.name === "net")!;
  net.files.push({ path: "preview-websocket-client.js", ...await bytes(new Blob([previewSocketScript])) });
  Object.assign(net, totals(net.files));
  const applications: Record<string, unknown> = {};
  for (const name of ["web", "sandbox"] as const) {
    // Shared service-worker source still belongs to this application's install.
    const outdir = resolve(root, ".runtime-size", `${name}-sw`);
    const { plugins } = browserBuildConfig([resolve(root, name, "src/main.ts")], outdir);
    const sw = await build({
      entrypoints: [resolve(root, "web/src/sw.ts")], outdir, plugins,
      target: "browser", format: "iife", minify: true,
      define: { __PREVIEW_SOCKET_SCRIPT__: JSON.stringify(previewSocketScript) },
    });
    const serviceWorker = await bytes(sw.outputs[0]!);
    applications[name] = { beforeUnsplit: await application(name, false, serviceWorker), afterSplit: await application(name, true, serviceWorker) };
  }
  return { method: "Same-source before/after splitting. gzip level 9; maps excluded. Layer closures export all public symbols, include transitive dependencies and overlap (not additive). Initial graph lists statically reachable request URLs with a scoped worker, counting root/scoped chunk copies separately regardless of SW proxy/cache reuse. The two-registration cold estimate adds a second classic SW fetch; neither estimate is a network capture. No WASM or app dist is read/built. Budgets for fs/net/proc are guides; only core is gated.", layers, applications };
}

if (import.meta.main) {
  const report = await runtimeSizeReport();
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.method);
    console.table(report.layers.map(({ name, minified, gzip, guideGzip }) => ({ layer: name, minified, gzip, guideGzip })));
    console.log("Core inputs, minified bytes only. Gzip contributions are not additive:");
    console.table(report.layers.find((layer) => layer.name === "core")!.inputs);
    for (const [name, scenarios] of Object.entries(report.applications)) {
const printApplicationSizes = () => {
      console.log(`\n${name}:`);
      for (const [scenario, details] of Object.entries(scenarios as Record<string, Awaited<ReturnType<typeof application>>>)) {
        console.log(`${scenario}: logical JS ${details.logicalJavaScript.minified} B / ${details.logicalJavaScript.gzip} B gzip; Bun light initial JS ${details.bunLightInitialJavaScript.minified} B / ${details.bunLightInitialJavaScript.gzip} B gzip`);
        console.table(details.logicalEntries.map(({ entry, minified, gzip }) => ({ entry, minified, gzip })));
        console.log("Bun light initial JS URLs:", details.bunLightInitialJavaScript.files.map((file) => file.path).join(", "));
        console.log("Other Bun light downloads:", details.otherBunLightDownloads.join(", "));
        console.log(`Proc eager: ${details.proc.eager}; ${details.proc.note}`);
      }

};
printApplicationSizes();
}
  }
  checkCoreBudget(report.layers.find((layer) => layer.name === "core")!.gzip);
}
