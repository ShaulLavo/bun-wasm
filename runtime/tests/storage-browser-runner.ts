import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { chromium, firefox, webkit, type Browser } from "../../web/node_modules/playwright";

type Backend = "indexeddb" | "opfs";
type WorkerRequest = { kind: "list" } | { kind: "run"; backend: Backend; label: string };
type TestList = Record<Backend, string[]>;

// Bun strips the types before toString(): the worker has TypeScript source, not handwritten JS.
function storageWorker(): void {
  globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
    try {
      const modulePath = "/tests.js";
      const tests = await import(modulePath) as typeof import("./storage-browser");
      const suites = { indexeddb: tests.storageTests(), opfs: tests.opfsStorageTests() };
      if (event.data.kind === "list") {
        globalThis.postMessage({ result: {
          indexeddb: suites.indexeddb.map(test => test.label), opfs: suites.opfs.map(test => test.label),
        } });
      } else {
        const { backend, label } = event.data;
        const test = suites[backend].find(test => test.label === label);
        if (!test) throw new Error(`Unknown ${backend} storage test: ${label}`);
        await test.run();
        globalThis.postMessage({ result: label });
      }
    } catch (error) {
      globalThis.postMessage({ error: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
  };
}

// Own all resources before setup: ephemeral listener, contexts/workers, profiles and scratch.
let scratch: string | undefined;
let firefoxScratch: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
let launch: Promise<Browser> | undefined;
let cleaning: Promise<void> | undefined;
const previousTmp = process.env.TMPDIR;
function cleanup(): Promise<void> {
  return cleaning ??= (async () => {
    try { await (browser ?? await launch?.catch(() => undefined))?.close(); }
    finally {
      server?.stop(true);
      try { if (scratch) await rm(scratch, { recursive: true, force: true }); }
      finally {
        if (firefoxScratch) await rm(firefoxScratch, { recursive: true, force: true });
        if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
      }
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { console.error("storage browser tests timed out"); void cleanup().finally(() => process.exit(1)); }, 600_000);

/** Each case gets a fresh context/origin store, so browser quotas and leaked state cannot cross cases. */
async function inWorker<T>(browser: Browser, request: WorkerRequest): Promise<T> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server!.port}`);
    return await page.evaluate(request => new Promise<T>((resolve, reject) => {
      const worker = new Worker("/worker.js", { type: "module" });
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error("storage case worker timed out")); }, 45_000);
      const finish = () => { clearTimeout(timeout); worker.terminate(); };
      worker.onmessage = event => {
        finish();
        if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
      };
      worker.onerror = event => { finish(); reject(new Error(event.message)); };
      worker.onmessageerror = () => { finish(); reject(new Error("Could not decode storage worker response")); };
      worker.postMessage(request);
    }), request);
  } finally { await context.close(); }
}

try {
  const scratchRoot = process.env.STORAGE_SCRATCH_ROOT ?? (process.platform === "darwin" ? resolve(homedir(), "tmp") : "/work/tmp");
  scratch = await mkdtemp(resolve(scratchRoot, "bun-wasm-storage-"));
  process.env.TMPDIR = scratch;
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "storage-browser.ts")], target: "browser" });
  if (!build.success) throw new AggregateError(build.logs, "Storage test bundle failed");
  const script = build.outputs[0]!;
  const workerScript = `(${storageWorker.toString()})();`;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/tests.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
    if (path === "/worker.js") return new Response(workerScript, { headers: { "content-type": "text/javascript" } });
    return new Response("<!doctype html><title>Storage tests</title>", { headers: { "content-type": "text/html" } });
  } });
  const failures: string[] = [];
  for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ["chromium"]) {
    const engine = { chromium, firefox, webkit }[name];
    if (!engine) throw new Error(`Unknown browser: ${name}`);
    // Firefox's profile must not live on /work's VDO filesystem. This tmpfs directory is
    // task-owned and removed after its browser stops; downloaded artifacts remain on /work.
    if (name === "firefox" && process.platform === "linux") firefoxScratch ??= await mkdtemp("/dev/shm/bun-wasm-storage-firefox-");
    process.env.TMPDIR = name === "firefox" && firefoxScratch ? firefoxScratch : scratch;
    launch = engine.launch({ headless: true, downloadsPath: scratch, tracesDir: scratch }); browser = await launch;
    try {
      const listed = await inWorker<TestList>(browser, { kind: "list" });
      const passed: TestList = { indexeddb: [], opfs: [] };
      let selected = 0;
      for (const backend of ["indexeddb", "opfs"] as const) for (const label of listed[backend]) {
        if (process.env.STORAGE_TEST_FILTER && !label.includes(process.env.STORAGE_TEST_FILTER)) continue;
        selected++;
        try {
          await inWorker<string>(browser, { kind: "run", backend, label });
          passed[backend].push(label);
          console.log(`  PASS ${name} ${backend}: ${label}`);
        } catch (error) {
          const failure = `${name} ${backend}: ${label}\n${String(error)}`;
          failures.push(failure); console.error(`  FAIL ${failure}`);
        }
      }
      if (selected === 0) throw new Error(`No storage cases match ${JSON.stringify(process.env.STORAGE_TEST_FILTER)}`);
      console.log(`${name} ${browser.version()}: ${passed.indexeddb.length} IndexedDB and ${passed.opfs.length} OPFS storage tests passed`);
    } finally { await browser.close(); browser = undefined; launch = undefined; }
  }
  if (failures.length) throw new AggregateError(failures.map(message => new Error(message)), `${failures.length} storage browser test(s) failed`);
} finally { clearTimeout(deadline); await cleanup(); }
