import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { WASI } from "node:wasi";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { NodeProcessBroker } from "../web/scripts/node-spawn.ts";
import { createNodeProcess, type NodeProcessOptions, type NodeWasiImports } from "../web/scripts/node-process.ts";

type Mode = "hostModuleSource" | "hostCjsSource";
interface BenchmarkData {
  module: WebAssembly.Module;
  wasm: string;
  mode: Mode;
  dir: string;
  transport: NodeProcessOptions["transport"];
  registry: NodeProcessOptions["registry"];
}
interface WasmCaller {
  describe(): { natives: readonly string[] };
  call(index: number, args: readonly string[]): unknown;
}
const root = resolve(import.meta.dirname, "..");

async function loadWasmCaller(): Promise<(exports: WebAssembly.Exports) => WasmCaller> {
  const modulePath = resolve(root, "web/src/engine-host.js");
  const source = readFileSync(modulePath, "utf8")
    .replace('import { installNativeStreamState } from "./native-stream-state.ts";', "const installNativeStreamState = () => () => {};")
    .replace('"waffle/core/memory-views"', JSON.stringify(pathToFileURL(createRequire(modulePath).resolve("waffle/core/memory-views")).href));
  const imports = ["buffer-transfer.ts", "content-modules.ts", "promise-reactions.ts", "crypto-inputs.js", "crypto-host.js", "net/trampoline.ts", "net/lookup.ts"];
  const rewritten = imports.reduce((source, path) => source.replace(JSON.stringify(`./${path}`), JSON.stringify(pathToFileURL(resolve(root, "web/src", path)).href)), source)
    .concat("\nexport { wasmCaller };\n");
  const module = await import("data:text/javascript;base64,".concat(Buffer.from(rewritten).toString("base64")));
  return module.wasmCaller;
}

function fixtureSources() {
  const count = 12_000;
  const plain = Array.from({ length: count }, (_, i) => `const v${i} = ${i};`).join("\n").concat("\nexport const answer = v11999;\n");
  return { plain, awaitCode: plain.concat("\nawait Promise.resolve();\n") };
}

async function benchmark(data: BenchmarkData, wasmCaller: Awaited<ReturnType<typeof loadWasmCaller>>): Promise<void> {
  const processHost = createNodeProcess({
    transport: data.transport, registry: data.registry,
    postMessage: message => parentPort!.postMessage(message),
    finish(code, signal): never {
      if (signal !== undefined) processHost.client.defaultSignal(processHost.client.pid, signal);
      else processHost.client.exit(code);
      processHost.dispose();
      process.exit(signal === undefined ? code : 128 + signal);
    },
  });
  let code = 1;
  try {
    const wasi = new WASI({ version: "preview1", args: ["bun", "run", "/large.mjs"], env: { PWD: "/", HOME: "/" }, preopens: { "/": data.dir }, returnOnExit: true });
    const imports = wasi.getImportObject() as NodeWasiImports;
    let instance: WebAssembly.Instance;
    const host = processHost.install(imports, () => instance);
    instance = await WebAssembly.instantiate(data.module, imports);
    host.installSlots();
    wasi.start(instance as Parameters<typeof wasi.start>[0]);
    const caller = wasmCaller(instance.exports);
    const names = caller.describe().natives;
    const native = (name: string) => {
      const index = names.indexOf(name);
      if (index < 0) throw new Error(`Missing benchmark native: ${name}`);
      return (path: string) => caller.call(index, [path]);
    };
    const prepare = native("hostModuleSource"), cjs = native("hostCjsSource");
    const results = { wasm: data.wasm, mode: data.mode, files: {} as Record<string, { bytes: number; coldMs: number; warmMedianMs: number; p10: number; p90: number }>, freshModuleMedianMs: {} as Record<string, number> };
    for (const name of ["large.mjs", "await.mjs", "large.ts"]) {
      const path = "/".concat(name);
      const start = performance.now();
      const info = prepare(path);
      const cold = performance.now() - start;
      if (typeof info !== "object" || info === null || !("format" in info) || info.format !== "esm") throw new Error("expected esm");
      const fn = data.mode === "hostCjsSource" ? cjs : prepare;
      for (let i = 0; i < 5; i++) fn(path);
      const samples: number[] = [];
      for (let i = 0; i < 31; i++) {
        const now = performance.now();
        fn(path);
        samples.push(performance.now() - now);
      }
      samples.sort((a, b) => a - b);
      results.files[name] = { bytes: readFileSync(resolve(data.dir, name)).byteLength, coldMs: cold, warmMedianMs: samples[15]!, p10: samples[3]!, p90: samples[27]! };
    }
    const { plain, awaitCode } = fixtureSources();
    for (const [name, source] of [["plain", plain], ["await", awaitCode], ["typescript", plain.concat("\nconst typed: number = 1;\n")]] as const) {
      const ext = name === "typescript" ? ".ts" : ".mjs";
      const samples: number[] = [];
      for (let i = 0; i < 15; i++) {
        const file = name.concat("-", String(i), ext);
        writeFileSync(resolve(data.dir, file), source);
        const start = performance.now();
        prepare("/".concat(file));
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      results.freshModuleMedianMs[name] = samples[7]!;
    }
    console.log(JSON.stringify(results, null, 2));
    code = 0;
  } finally {
    processHost.client.exit(code);
    processHost.dispose();
  }
}

async function main(wasm: string, mode: Mode): Promise<void> {
  const dir = mkdtempSync("/work/tmp/bun-wasm-module-preparation-");
  let broker: NodeProcessBroker | undefined;
  let guest: Worker | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Module preparation benchmark interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const { plain, awaitCode } = fixtureSources();
    for (const [name, source] of [["large.mjs", plain], ["await.mjs", awaitCode], ["large.ts", plain.concat("\nconst typed: number = 1;\n")]]) writeFileSync(resolve(dir, name!), source!);
    const module = await WebAssembly.compile(readFileSync(wasm));
    const settings = { wasmPath: wasm, stackMb: 32, withNet: false, preopens: { "/": dir }, env: { PWD: "/", HOME: "/" }, args: [] };
    broker = new NodeProcessBroker({ module,
      launch: (context, transport) => new Worker(new URL("../web/scripts/node-host.ts", import.meta.url), {
        workerData: { module: context.module, settings, transport, request: context.request }, resourceLimits: { stackSizeMb: 32 },
      }),
    });
    const transport = broker.root;
    const registry = (transport.data as { registry: NodeProcessOptions["registry"] }).registry;
    guest = new Worker(new URL(import.meta.url), { workerData: { module, wasm, mode, dir, transport, registry } satisfies BenchmarkData, resourceLimits: { stackSizeMb: 32 } });
    broker.attach(guest, transport);
    await new Promise<void>((resolve, reject) => {
      const cancel = () => reject(abort.signal.reason);
      abort.signal.addEventListener("abort", cancel, { once: true });
      if (abort.signal.aborted) cancel();
      timeout = setTimeout(() => abort.abort(new Error("Module preparation benchmark exceeded 120 seconds")), 120_000);
      guest!.once("error", reject);
      guest!.once("exit", code => {
        abort.signal.removeEventListener("abort", cancel);
        if (code === 0) resolve();
        else reject(new Error(`Module preparation benchmark worker exited ${code}`));
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    await guest?.terminate();
    broker?.dispose();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const wasmCaller = await loadWasmCaller();
  if (!isMainThread) await benchmark(workerData as BenchmarkData, wasmCaller);
  else if (process.argv[2] !== "--check") {
    const wasm = process.argv[2], mode = process.argv[3] ?? "hostModuleSource";
    if (!wasm || !["hostModuleSource", "hostCjsSource"].includes(mode)) throw new Error("Usage: node scripts/bench-module-preparation.mjs <bun-browser.wasm> [hostModuleSource|hostCjsSource]");
    await main(resolve(wasm), mode as Mode);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
