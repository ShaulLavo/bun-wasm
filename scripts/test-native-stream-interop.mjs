import { stripTypeScriptTypes } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argument = name => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
function inputs() {
  const sourceRoot = join(root, "crates/bunwasm-runtime/src/js");
  const names = ["buffer", "events", "streams", "node_stream_core", "node_stream_web", "node_stream_bindings", "native_stream_state"];
  const sources = Object.fromEntries(names.filter(name => existsSync(join(sourceRoot, name + ".js"))).map(name => [name, readFileSync(join(sourceRoot, name + ".js"), "utf8")]));
  sources.compression_streams = stripTypeScriptTypes(readFileSync(join(sourceRoot, "compression_streams.ts"), "utf8"));
  const builtins = readFileSync(join(sourceRoot, "builtins.js"), "utf8");
  sources.asyncHooks = builtins.slice(builtins.indexOf("  function asyncHooksModule()"), builtins.indexOf("  function diagnosticsChannelModule()"));
  sources.hostBridge = stripTypeScriptTypes(readFileSync(join(root, "web/src/native-stream-state.ts"), "utf8"));
  sources.fromControls = stripTypeScriptTypes(readFileSync(new URL("../web/tests/native-readable-from-controls.ts", import.meta.url), "utf8"));
  sources.completionControls = stripTypeScriptTypes(readFileSync(new URL("../web/tests/native-stream-completion-controls.ts", import.meta.url), "utf8"));
  sources.fixture = readFileSync(join(root, "tests/fixtures/node-native-web-streams/index.js"), "utf8");
  return sources;
}
if (argument("--dump")) { writeFileSync(argument("--dump"), JSON.stringify(inputs())); process.exit(0); }
const sources = argument("--sources") ? JSON.parse(readFileSync(argument("--sources"), "utf8")) : inputs();
sources.benchmark = process.argv.includes("--benchmark");
const location = process.env.PLAYWRIGHT ?? join(root, "web/node_modules/playwright/index.mjs");
const playwright = await import(pathToFileURL(location).href);
let failures = 0;
for (const name of ["chromium", "webkit"]) {
  let browser;
  try {
    browser = await playwright[name].launch({ headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(String(error)));
    const result = await page.evaluate(async sources => {
      const native = { ReadableStream, WritableStream, TransformStream };
      // Median of seven runs after three warm-up runs; still noisy on a busy host.
      async function constructionTime(Ctor) {
        const count = 10000;
        async function run() {
          const start = performance.now();
          for (let i = 0; i < count; i++) {
            const stream = new Ctor({ start(controller) { controller.close(); } });
            await stream.cancel();
          }
          return performance.now() - start;
        }
        for (let i = 0; i < 3; i++) await run();
        const runs = [];
        for (let i = 0; i < 7; i++) runs.push(await run());
        return { count, milliseconds: runs.toSorted((a, b) => a - b)[3], runs };
      }
      const nativeConstruction = sources.benchmark ? await constructionTime(native.ReadableStream) : undefined;
      const dispose = sources.hostBridge ? new Function(sources.hostBridge.replace("export function installNativeStreamState", "function installNativeStreamState") + ";return installNativeStreamState();")() : () => {};
      const bridgeConstruction = sources.benchmark ? await constructionTime(ReadableStream) : undefined;
      const cache = new Map();
      let frame;
      const proc = { env: {}, nextTick: (fn, ...args) => queueMicrotask(() => fn(...args)), versions: { node: "26.7.0" }, stderr: { write() {} }, emitWarning() {} };
      const internal = {
        native: { engine: "host", getAsyncContext: () => frame, setAsyncContext: value => { frame = value; } },
        runInContext(context, fn, self, args) { return Reflect.apply(fn, self, args); },
        builtin(name) {
          if (name === "node:process") return proc;
          if (name === "node:buffer") return internal.require("buffer");
          if (name === "node:events") return internal.require("events");
          if (name === "node:zlib") return { constants: { Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3 } };
          if (name === "node:util/types") return { isAnyArrayBuffer: value => /\[object (Shared)?ArrayBuffer\]/.test(Object.prototype.toString.call(value)) };
          if (name === "node:async_hooks") return new Function("internal", "native", sources.asyncHooks + ";return asyncHooksModule();")(internal, internal.native);
          throw new Error("Unexpected test host builtin " + name);
        },
        require(name) {
          if (cache.has(name)) return cache.get(name);
          if (!sources[name]) throw new Error("Missing runtime module " + name);
          // oxlint-disable-next-line no-eval -- Exercise the runtime classic-script factory or engine evaluator.
          const value = (0, eval)(sources[name])(internal);
          cache.set(name, value);
          return value;
        },
      };
      globalThis.process = proc;
      internal.require("streams");
      const bundle = internal.require("node_stream_core");
      internal.require("node_stream_web")(bundle);
      const body = sources.fixture.replace(/^import .*from "node:stream";$/m, "const { Readable, Writable, Duplex, finished, addAbortSignal, pipeline, compose } = core;")
        .replace(/^import .*from "node:stream\/promises";$/m, "const { finished: finishedPromise, pipeline: pipelinePromise } = core.promises;");
      let error;
      try { await new Function("core", "return (async () => {" + body + "})()")(bundle.Stream); }
      catch (failure) { error = String(failure); }
      try {
        const checkFrom = new Function(sources.fromControls.replace("export async function checkNativeReadableFrom", "async function checkNativeReadableFrom") + ";return checkNativeReadableFrom;")();
        const rows = await checkFrom(native.ReadableStream);
        globalThis.__nativeStreamResults = globalThis.__nativeStreamResults.concat(rows);
      } catch (failure) { error = String(failure); }
      const checkCompletion = new Function(sources.completionControls.replace("export async function checkNativeStreamCompletion", "async function checkNativeStreamCompletion") + ";return checkNativeStreamCompletion;")();
      const completionRows = await checkCompletion();
      globalThis.__nativeStreamResults = globalThis.__nativeStreamResults.concat(completionRows);
      const brands = Object.fromEntries(Object.entries(native).map(([name, Ctor]) => [name, {
        sameConstructor: globalThis[name] === Ctor,
        samePrototype: globalThis[name].prototype === Ctor.prototype,
        nativeInstance: new globalThis[name]() instanceof Ctor,
        constructorLink: globalThis[name].prototype.constructor === globalThis[name],
      }]));
      dispose();
      return { results: globalThis.__nativeStreamResults ?? [], error, brands, construction: sources.benchmark ? { native: nativeConstruction, bridge: bridgeConstruction, timingsAreNoisy: true } : undefined };
    }, sources);
    const summary = { browser: name, version: browser.version(), ...result, pageErrors };
    console.log(JSON.stringify(summary));
    if (result.error || pageErrors.length || result.results.some(row => !row.pass)) failures++;
  } finally { await browser?.close(); }
}
if (failures) process.exitCode = 1;
