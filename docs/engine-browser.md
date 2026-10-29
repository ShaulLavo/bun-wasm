# The browser engine (`bun-browser.wasm`)

bun-wasm has three engines behind one runtime:

| engine | JS runs on | wasm |
|---|---|---|
| QuickJS | QuickJS-ng compiled into the wasm | `dist/bun.wasm` |
| JSC | JavaScriptCore (no JIT) compiled into the wasm | `dist/bun-jsc.wasm` |
| browser | the host's own engine: V8 in Chromium and Node, JavaScriptCore with JIT in Safari | `dist/bun-browser.wasm` |

The browser engine runs user code and the runtime's JS polyfills (`crates/bunwasm-runtime/src/js/*.js`) directly on the host JS engine, in the same Web Worker as the wasm. The wasm keeps the parts that are Bun proper and don't depend on a JS engine:

- argument parsing and `bun test` / `bun -e` entry selection;
- module resolution (tsconfig paths, package.json `exports`, node_modules);
- Bun's transpiler (TS/JSX → JS, with source maps) and `bun build`;
- `bun:sqlite`, hashing and compression;
- the WASI file system and stdout/stderr buffering.

Isolation isn't a goal: user code shares the worker's global object with the host glue.

Build it with `scripts/build-bun-browser.sh`, which compiles `bunwasm-cli` with `--no-default-features --features engine-host,bun-transpiler,bun-build` and then runs wasm-opt `-O2`. The output is 8.2 MB raw and 2.9 MB gzipped. The other engines are larger:

| wasm | raw | gzipped |
|---|---|---|
| `bun.wasm` (QuickJS) | 8.9 MB | 3.2 MB |
| `bun-jsc.wasm` | 42.8 MB | 11.5 MB |

The host side is one plain-JS ES module, `web/src/engine-host.js`, used both by the playground worker (`web/src/worker.ts`) and by the headless runner (`web/scripts/node-host.mjs`).

## AsyncLocalStorage and native continuations

The Node host supplies `EngineHostOptions.asyncContext` using Node's native `AsyncLocalStorage`. The runtime stores its frame in that continuation slot. Native promise jobs capture and restore it, including raw awaits in direct eval and `new Function` bodies. The host's synthetic await hooks become no-ops on this path, and its promise wrappers leave context entry and exit to Node.

Browser workers have no equivalent public continuation API. Their source hooks cannot preserve exact request context for dynamically evaluated async code. In particular, Next.js development Webpack chunks can lose the request store during metadata resolution and throw E696. Run the whole process on QuickJS for this workload: select `?engine=quickjs` in the playground, or supply the matching QuickJS guest with `engine: "quickjs"` to `installBunAdapters`. QuickJS runs inside Wasm without JIT, so execution can be slower. Selecting it does not repair the browser-native engine.

The [metadata continuation regression](bun-patches/next-metadata-context.md) preserves the captured functions and distinguishes the two-segment failure from the resolving layout-only control. It does not establish the cause of a particular live HTTP response.

## How the Engine trait maps onto the host

The QuickJS and JSC engines implement the `Engine` trait (`crates/bunwasm-runtime/src/engine.rs`) inside the wasm. The browser engine cannot do that, because its values live outside the wasm. The split is the one the trait already draws:

- **Data natives** (`natives.rs`, a `Table` of `DataFn`s taking and returning `Val`) need no engine. The wasm exports them by index.
- **Value natives** take or return live JS values: functions, promises, module namespaces. On the other engines they are `ValueFn<E>`. Here `engine-host.js` implements them in JS (see `valueNatives()`).

Feature `engine-host` (crate `bunwasm-runtime`, forwarded by `bunwasm-cli` together with its required `bun-transpiler` feature) compiles `src/engine_host.rs` instead of the QuickJS/JSC engines. `run()` builds the runtime `State` as usual: entry, argv, environment, transpiler. It then fills a native `Table` and returns instead of running an event loop, and `main` returns from `_start` without calling `proc_exit`. The host checks `bunwasm_ready()` to tell "ready for the host engine" from an early exit, such as `bun --version` or a usage error.

### Exports

| export | |
|---|---|
| `bunwasm_ready() -> i32` | 1 after `_start` set up a host-engine run |
| `bunwasm_describe() -> i32` | result: `{natives: [names], constants: {...}, entry: {kind, main, args}}` |
| `bunwasm_alloc(len) -> ptr` | scratch buffer for call arguments |
| `bunwasm_call(index, ptr, len) -> i32` | call native `index` with encoded args; 0 ok, 1 threw |
| `bunwasm_result_ptr/len()` | the encoded result (or error) of the last call |

Values cross as a small tagged encoding that mirrors `Val`:

| tag | type | payload |
|---|---|---|
| 0, 1 | undefined, null |
| 2, 3 | false, true |
| 4 | f64 | 8 bytes LE |
| 5 | string | u32 length + UTF-8 |
| 6 | bytes | u32 length + data |
| 7 | array | u32 count + values |
| 8 | object | u32 count + (key, value) pairs |
| 9, 10 | BigInt (i64, u64) | 8 bytes LE |

An error result is `{kind, message, name, props}`, which `nativeError()` turns back into a JS error. The codec lives in `engine_host.rs` (`encode`/`decode`, with unit tests) and in the `Writer`/`Reader` classes in `engine-host.js`.

### Host-only natives

`install_host_natives` adds four natives:

- **`hostModuleSource(path)`:** the transpiled ESM source, plus the byte spans of every static and dynamic import specifier, each resolved to a module key or an error. See below.
- **`hostCjsSource(path)`:** the CommonJS-wrapped source. It is the same wrapper the other engines use, named `__bunwasm_cjs__`.
- **`polyfillSource(name)`:** the embedded runtime JS (`bootstrap`, `builtins`, …).
- **`flushOutput()`:** writes buffered stdout/stderr through WASI.

### Startup

1. `wasi.start(instance)` runs Rust `main` up to `bunwasm_ready() === 1`.
2. `startEngineHost({instance, moduleUrls, fetch, onExit})`:
   1. `describe()` builds the `native` object: data natives become JS functions over `bunwasm_call`, and the value natives are added.
   2. It evaluates `bootstrap.js` with indirect eval, which installs the polyfill globals (`process`, `Bun`, timers, web APIs, `require`).
   3. It installs the module hooks, the native-fetch adapter and the rejection watchers, runs the entry, and starts the loop.

Before bootstrap replaces them, `engine-host.js` captures the host's own `setTimeout`, `MessageChannel`, `queueMicrotask`, `Blob`, `URL.createObjectURL`, `TextEncoder`/`TextDecoder`, `AbortController` and, in Node, `process`.

## Event loop: the host owns it

The host engine owns the microtask queue and the worker's task loop, so the runtime cannot run a loop of its own. `engine-host.js` drives the polyfill timers:

- **`pump()`** is one macrotask. It runs due timers and immediates through `internal.runTimers()`, flushes output, and schedules the next turn: a `MessageChannel` post when something is due now, a native `setTimeout` for the next deadline. Microtasks run natively between turns.
- **Waking the loop:** the polyfill's timer insertion and `setImmediate` call `native.wake(ms)`, so a timer created while the loop is waiting re-arms it. This covers timers from a `then` callback or under top-level await (fixture `tla-timers`).
- **`track(promise)`** counts host async work: native fetch and dynamic imports. The program isn't idle while that count is non-zero.
- **Idle:** with no timers and nothing tracked, the loop waits one more macrotask, because Chromium reports unhandled rejections in a later task. It then emits `beforeExit` (which may schedule more work), runs `exit` handlers, flushes, and calls `onExit(code)`.
- **`process.exit()`** calls `onExit`, then throws an `ExitSignal` that unwinds the current JS stack. The guards and the rejection watcher ignore that signal.
- **`process.nextTick`:** the tick queue is drained by a native microtask. Bun runs ticks before promise jobs that were queued earlier, but the host's job queue can't be reordered. Instead, `Promise.prototype.then` is wrapped, and each callback drains pending ticks before it runs. `queueMicrotask` goes through `then`, so the fixtures' orderings match Bun. The same wrapper restores the AsyncLocalStorage context the callback was registered in.
- **Uncaught errors and rejections** go to the polyfill's `handleUncaught`/`handleRejection`, so `process.on("uncaughtException")` and Bun's error printing behave as on the other engines. They come in from the worker's `error`/`unhandledrejection` events, or Node's `process` events headlessly.

## ES modules: native, with live bindings

Every user module is a real host ES module, so bindings are live, top-level await works, and `import.meta` is native:

1. `ensureModule(key)` asks the wasm for `hostModuleSource(key)`. That is the transpiled code plus cached semantic import spans. Bun's existing print pass records emitted string ranges and dynamic-import keywords for transformed code. Unchanged JavaScript reuses the AST and original dynamic-import locations from the parse already required to classify module syntax, and skips printing. For `.mjs` and `.cjs`, the extension already decides the format, so Bun's scan-only parser supplies imports instead. An absence check for `import` and `from` skips scanning when no import or re-export is possible. Eval sources use Bun's scan-only parser once, with a cheap absence check for both `import` and `from`. Imports inside template substitutions use the same semantic hooks. Property names, strings, comments, regex literals, and template text remain untouched. Each static specifier is resolved in Rust, with Bun's resolver semantics.
2. `linkEsm` replaces each static specifier span with the URL of the dependency, created recursively. Replacement runs on UTF-8 bytes from the end. Each dynamic `import(` becomes `globalThis.__bunwasm_dynamicImport(<referrer>)(`, which resolves at call time, creates the module URL and is tracked by the loop.
3. The browser makes a `blob:` URL from each module's finished source. A cycle instead reserves a named URL before the source exists. This lets imports link natively, with live bindings and hoisted functions callable before their module has evaluated, as in Bun (fixture `esm-cycle`). The URL → path table records both kinds of URL.
   - **Playground:** the service worker (`web/src/sw.ts`) has a second scope, `./__bunwasm/`. Bun workers start from `./__bunwasm/worker.js`. Acyclic imports need no HTTP request, even when WebKit starts a worker outside service-worker control. A cycle stores the reserved module in a per-run Cache Storage cache, served at `./__bunwasm/m/<run>/<key>`. Cycles still need service-worker control. The page deletes the cache when the run ends.
   - **Node:** in-thread module hooks (`module.registerHooks`) serve `bunwasm:/m/<key>` from memory.
   - **Without a store** (no service workers): `blob:` (browser) or `data:` (Node) URLs made from the finished source. These can't express cycles, so a cycle is an `ERR_CIRCULAR_IMPORT` error.
4. A prologue line (`globalThis.__bunwasm_meta(import.meta, "/path")`) gives `import.meta` Bun's `path`, `dir`, `file`, `main`, `resolve` and `require`. It is one line, and the source map's line offset accounts for it (`PositionMap.line_offset`).

CommonJS, JSON, text and builtin (`node:*`, `bun:*`) imports are evaluated through the polyfill `require` machinery, so they share `require.cache`. A wrapper module re-exports the result: `export default` plus one named export per enumerable key at import time, which is Bun's CJS interop. CommonJS itself is compiled by indirect `eval` of the wrapped source, with `//# sourceURL=<path>`. Its `import(…)` calls are routed through the same dynamic-import hook as in ES modules.

**`require()` of an ES module** can't evaluate the host ES module synchronously. Instead, Bun's bundler converts the file (`Transpiler::esm_to_cjs`: format `cjs`, every import external, inline source map), and the result runs as CommonJS. Its imports become `require()` calls read through live getters, and stack positions map back to the file. As in Bun, top-level await in such a module is an error. A file that is both required and imported runs twice: once as the converted CommonJS copy, once as the ES module.

The entry is `import(url)` of the main module. `bun -e` code goes through the same path, as a virtual `[eval]` module. `bun test` loads each test file as a module under the polyfill test runner.

## Stack traces and source maps

The engine's stack is mapped back to the original TS/JS positions with the same source maps (`native.mapPosition`), and printed with Bun's format by the shared inspect code.

**V8 (Chromium, Node)** calls `Error.prepareStackTrace` with structured call sites, and `formatCallSite` in `bootstrap.js` formats them:

- File names come from `getScriptNameOrSourceURL()`, which is the `sourceURL` for eval'd CommonJS. `internal.displayName` maps them through the URL → path table.
- Frames from the host glue, the worker bundle and `node:internal` show as `bun-wasm:host` and are dropped like other runtime frames.
- Strict-mode frames hide their function. A nameless frame is top-level (printed bare) only when its enclosing position is 1:1; otherwise it prints `<anonymous>`, as in Bun.
- V8 puts `new Error()` at `new`, while Bun (JSC) puts it at the constructor name. The column is moved past `new `.

**JavaScriptCore (Safari) and SpiderMonkey** ignore `prepareStackTrace`. Their `name@url:line:col` stacks are parsed when printed (`parseJscFrameLine` in `inspect.js`), with the same `displayName` and `mapPosition` steps. The output is Bun's format in both cases. Raw `err.stack` strings read by user code follow the host engine's own format.

## Performance

These are Chromium medians of three runs on localhost, from `web/tests/bench-engines.mjs`, in ms. The micro columns are `tests/bench/micro.js`; "cold" is a first `console.log(1)` run and "warm" is a repeat.

| engine | wasm .gz | page→ready | cold | warm | loop | regexp | json | alloc | strings | micro total |
|---|---|---|---|---|---|---|---|---|---|---|
| QuickJS | 3.2 MB | 195 | 57 | 24 | 195 | 96 | 163 | 434 | 9 | 922 |
| JSC (no JIT) | 11.5 MB | 278 | 157 | 35 | 250 | 69 | 49 | 543 | 6 | 936 |
| browser | 2.9 MB | 199 | 31 | 15 | 3 | 6 | 15 | 66 | 4 | 107 |

In WebKit the browser engine takes 36/18 ms cold/warm and 131 ms for the micro run. QuickJS takes 911 ms for the micro run and JSC 1155 ms.

## Networking

`startEngineHost` takes `o.net`: the `bun_wasm` host ABI (`docs/host-abi.md`) as the JS functions the runtime's `net.js` calls (`native.hostListen`, `hostRead`, …), the slots it covers, and an `onNews` callback that wakes the loop. Nothing blocks. `pump()` steps net.js's waiters, and keeps the program alive while any are referenced. With `o.net`, `fetch`, `Bun.serve`, `node:http` and `node:net` work as on the wasm engines:

- **Playground:** the worker uses the same `NetHost` as the wasm engines, through `engineNet()`: byte arrays instead of guest memory, and `Atomics.waitAsync` on the ring instead of a blocking `poll`. Bun.serve previews therefore go through the service worker's `/__preview/<port>/` route, and `fetch` through the page's helper. This needs a cross-origin isolated page. Without one, user code gets the worker's own `fetch` and no servers.
- **Node** (`node-host.mjs --net`, used for fixtures marked `host`): `web/scripts/node-net.mjs` runs real sockets (`node:net`) and a `node:http(s)` client. Node's own `fetch` can't be used once the polyfills replace the web stream globals.

## Promise state and AsyncLocalStorage

The host engine exposes neither, so the browser engine reconstructs both:

- **Promise state:**
  - The host records a promise's state where it sees the promise settle: `Promise.resolve`, `Promise.reject` and `Promise.withResolvers` (synchronously at creation), and every `then` callback, which now always runs and defaults to what the missing handler would do.
  - The constructor is not replaced, so `instanceof`, `constructor` identity, species and `await`'s fast path are unchanged.
  - Promises settled elsewhere (`new Promise`, async functions, runtime APIs) print as `<pending>`.
- **AsyncLocalStorage across `await`:**
  - For this build, Bun's printer (patch `0008`) prints `await x` as `__bunwasm_resume(__bunwasm_capture(), await x)`. Arguments evaluate in order, so the context is captured before the suspension and restored when the function resumes.
  - A rejected `await` throws before `resume` runs, so an async body whose own statements hold a `try` or a `for await` (an *S body*, including a module top level that awaits) gets a different shape. It declares `let __bunwasm_s = 0;` after its directives. Its awaits become `__bunwasm_resumed(await __bunwasm_id(x, __bunwasm_s = __bunwasm_capture()), __bunwasm_s, __bunwasm_s = 0)`, which awaits `x` itself (no extra `then` or `constructor` reads, no extra jobs) and leaves the captured frame in `__bunwasm_s` when `x` rejects. Every `catch` and `finally` block starts with `__bunwasm_caught(__bunwasm_s, __bunwasm_s = 0)`, which re-enters that frame. A synchronous throw finds `__bunwasm_s === 0` and keeps the current frame.
  - Async generator `yield x` in an S body is printed as `__bunwasm_id(yield __bunwasm_id(x, __bunwasm_s = __bunwasm_capture()), __bunwasm_s = 0)`. `%AsyncGeneratorPrototype%.throw` is wrapped so the handlers it runs synchronously keep the caller's frame; the wrapper keeps `name` and `length`, but its `toString()` is no longer native code.
  - `for await` prints as `{ let __bunwasm_c; try { for await (… of __bunwasm_c = __bunwasm_iterate(y)) { try { __bunwasm_entered(__bunwasm_c); … } finally { __bunwasm_caught(__bunwasm_s, __bunwasm_s = 0); } } } finally { __bunwasm_exited(__bunwasm_c); } }`. `__bunwasm_iterate` gets the iterator itself with the reads and calls of `GetIterator` (a sync iterable stays sync, so the engine still adapts it) and notes the frame only once `next()` or `return()` has returned, right before the implicit await. An iterator method that throws synchronously therefore leaves nothing pending. The body starts in its `next()` frame; a rejected await in the body re-enters its own frame before the iterator closes; the outer `finally` runs after the iterator closed on every exit, labeled `break` and `continue` to an enclosing loop or block included, and re-enters the frame of the last `next()` or `return()`. Labels stay on the loop.
  - `__bunwasm_s`, `__bunwasm_c` and the other `__bunwasm_*` names are reserved in printed code. The shapes have a version (`describe().prepareVersion`), which keys the runtime's cached printed sources.
  - Known gaps, measured against Node by `tests/async-context-rejection`: a rejection out of `yield*` caught in the delegating generator sees the frame at delegation start (G1); an async generator's `finally` after `return()` from another frame sees its last `yield`'s frame (G2); destructuring or defaults in `catch (pattern)` run before the hook (G5); `await using` is not hooked (G6); a rejected `return x` in an async generator reaches its handlers without a hook.
  - Plain `.js` files that contain `await` go through the transpiler in this build so that they get the hooks, and their stacks stay source-mapped.
  - `then` callbacks, timers, ticks and immediates carry their own context.
  - The TC39 AsyncContext proposal (`AsyncContext.Variable`) would make the hooks unnecessary. It was at stage 2 at the time of writing and no engine we target ships it, even behind a flag.
  - **Leak, and how it is contained:** a resumed context would stay set for whatever runs after the function suspends again or returns. A microtask puts the previous context back once the resumed job left it unchanged. Native jobs queued before that microtask (for example a MessagePort event in user code) can still see the resumed context.

## Headless testing

`scripts/test.sh --engine browser` runs every fixture under Node (V8) through `web/scripts/node-host.mjs`:

- `node:wasi` with the fixture dir preopened as `/`;
- `startEngineHost` with module hooks serving the program's ES modules;
- with `--net` (fixtures marked `host`): real sockets and an HTTP client (`node-net.mjs`); otherwise Node's `fetch` as the host fetch.

`--context hooks` (`node-host.mjs --context hooks`) leaves out Node's native `AsyncLocalStorage` slot, so AsyncLocalStorage depends on the printed hooks exactly as in a browser.

Node is the closest headless stand-in for a worker: it has V8, ES modules from `data:` URLs, `MessageChannel`, `fetch` and `process` events. Bun can't host it, because its `Bun` global is not configurable and the polyfills must replace it.

`scripts/test-host-profile.sh` builds the exact `--no-default-features --features engine-host,bun-build` profile and runs eval plus TypeScript static and dynamic imports. Run it through the build slot wrapper.

`scripts/bench-module-preparation.mjs <wasm> [hostModuleSource|hostCjsSource]` measures the actual module-preparation ABI on 242 KB plain JS, JS with await, and TypeScript inputs. Its TypeScript harness runs the guest in a worker with the headless host's real process imports and descriptor table; the main thread keeps the shared process broker responsive. It reports medians across 15 fresh paths and 31 cached preparations per input. Run it through the light slot wrapper on before/after artifacts. It stops its worker and removes temporary fixtures on success, failure, interruption or its 120-second deadline. `--check` validates the host source wrapper without a Wasm artifact. These are module-preparation timings in Node, not browser startup timings.

The browser side is covered by `scripts/test-web.sh`, which includes `web/tests/browser-engine.mjs` in Chromium and WebKit, and by `web/tests/bench-engines.mjs` for timings.

## What is inherently different

These follow from running on a standard JS engine without engine hooks. Every fixture passes under `--engine browser`; the remaining differences are:

| what | browser engine |
|---|---|
| Promise state | Known only for promises settled where the host sees it (see above). Others print as `<pending>`, and `Bun.peek` returns them unchanged. |
| AsyncLocalStorage | Carried across `await`, rejected awaits, async generators and `for await` by the transpiler hooks, with the gaps listed above. Code that skips the transpiler (`eval`, `new Function`) and native jobs (see above) are not covered. |
| `require()` of an ES module | A converted CommonJS copy, separate from the ES module instance if the file is also imported. |
| Import cycles | Need the module store (a service worker in the browser). Without it, a cycle is an error. |
| Proxy detection, Map/Set iterator entries in `console.log` | Inspection prints less, e.g. a Proxy prints as its target. |
| `process.memoryUsage()` | `performance.memory` where available (Chromium), else zeros. `rss` equals `heapUsed`. |
| Stack strings | `err.stack` read directly is V8's `    at f (url:line:col)` or JSC's `f@url:line:col`, with module URLs. Bun-style printing (uncaught errors, `console.log(err)`, `bun test`) is mapped and matches the other engines. |
| `process.nextTick` vs `await` continuations | Ticks run before `.then`/`queueMicrotask` callbacks queued earlier, but not before `await` continuations queued earlier. |

Everything else, including the transpiler, resolver, `bun test`, `bun build`, sqlite, fetch, timers, the file system, stdin and exit codes, matches the other engines on the fixture suite.
