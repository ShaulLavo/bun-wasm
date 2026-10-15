# Bun JavaScript builtins

Bun's generated module factories can run on QuickJS, JavaScriptCore in wasm, and the browser engine. Public modules switch to these factories only after a measured comparison. The generated registry also contains modules that still need native bindings; listing a module does not enable it.

## Module loader

`scripts/generate-bun-builtins.sh` runs Bun's own `src/codegen/bundle-modules.ts` in a private temporary directory. It selects production codegen with `TARGET_PLATFORM=linux` and `TARGET_ARCH=x64`. Linux selects the POSIX API branches supported by this WASI guest. Bun rejects wasm32 codegen in node:os with bundleError for endianness and machine. The generator rejects any selected source that refers to process.arch, so no architecture-specialized module ships under the host architecture policy. Porting those modules needs a real WASI codegen policy. This does not give WASI a Linux kernel or native processes.

The generator consumes `tmp_modules/modules_out`, immediately before Bun rewrites ordinary `__intrinsic__` identifiers to JSC's `@` syntax. TypeScript's JavaScript AST rewrites those identifiers into a factory-local `intrinsics` object. String literals and regular expressions keep their contents. The export marker becomes a return statement. Intrinsic property calls use captured Function and Reflect operations. Private property names become stable, per-runtime symbols.

`scripts/bun-builtins.json` selects module roots. Their generated static dependency closure is embedded in `crates/bunwasm-runtime/generated/builtins/`. All other source stays out of the wasm. The full catalog records 211 registry entries, 198 JavaScript modules and 13 native modules, together with 236 generated native-hook IDs. Its revision is the last commit affecting src/js, codegen, the native-module list, or the error-code table. Each JavaScript entry also records its original source hash. It is review metadata and is not embedded in the wasm.

The Rust `bunBuiltinSource` data native returns one factory source. Its registry, source lookup, hook names, and error codes live in the shared data-native table used by all engines. The adapter compiles it with the existing `native.evalScript`, backed by `Engine::eval_script` for QuickJS and JSC and the browser host's evaluator for the host engine. It does not evaluate the factory body. `src/js/bun_builtins.js` invokes that body on first require and caches its exported value by Bun's registry ID. Failed initializations can be retried. Circular initialization fails explicitly instead of recurring indefinitely. CJS require and ESM import share the existing builtin registry and its exports.

An unembedded public dependency delegates to the existing `internal.builtin` implementation. An unembedded internal dependency fails explicitly. This is the module migration boundary, not support for mixed software versions. No new global variables or prototype properties implement intrinsics. The adapter itself loads only when a switched module first requires it.

## Intrinsics

The generated [catalog](../crates/bunwasm-runtime/generated/builtins/catalog.json) lists each module's intrinsic names, private property names, dependency IDs, and native-hook IDs. Names below omit Bun's `$` prefix.

| Intrinsic | Implementation | Limit |
| --- | --- | --- |
| Array, ArrayBuffer, Buffer, Promise, String, RegExp, Uint8Array, stream constructors, Infinity, isFinite, undefined | Runtime globals through the lexical table | A global the runtime does not implement remains unavailable. |
| call, apply, bind | Captured Function methods and Reflect.apply | User-defined own call/apply/bind properties do not intercept them. |
| getPrototypeOf, setPrototypeOf, getOwnPropertyDescriptor | ECMAScript object operations | No engine-specific layout assumptions. |
| isCallable, isObject, isJSArray, isArray | JavaScript type checks and Array.isArray | No native hook. |
| isPromise, isProxy, isError | Existing value natives over Engine | Same implementation as runtime introspection. |
| newArrayWithSize | New array with the specified length | Creates holes, as Bun's builtin expects. |
| getByIdDirect | Own property descriptor value | Does not invoke accessors or inherited getters. |
| putByIdDirect | Define an own writable enumerable configurable data property | Does not invoke inherited setters. |
| getByIdDirectPrivate, putByIdDirectPrivate, private property accesses | Per-runtime Symbol keys | Symbols are discoverable by Reflect.ownKeys. Modules requiring engine-private secrecy remain blocked. |
| internalModuleRegistry, getInternalField, createInternalModuleById | Per-runtime module cache and lazy loader | Initialization cycles report an unsupported operation. |
| makeTypeError, throwTypeError, throwRangeError | ECMAScript error constructors | No native hook. |
| makeErrorWithCode | Generated error-code table, URIError for ERR_INVALID_URI | Other error constructors explicitly fail until ported. |
| lazy | Generated native-hook dispatch metadata | Function hooks return a callable that throws on invocation. Binding-object hooks throw immediately. |
| requireMap | Explicit ERR_BUN_BUILTIN_UNSUPPORTED | Needs Bun's CommonJS cache protocol; it is distinct from the builtin registry. |
| Any other intrinsic | Explicit ERR_BUN_BUILTIN_UNSUPPORTED | No fake successful result. |

## Native hooks

No native hook is needed by `internal:freelist`, the initial loader probe. Engine operations already available through the runtime are reused rather than implemented separately for each engine.

| Hook | Implementation | State |
| --- | --- | --- |
| bunBuiltinSource | Shared data-native source lookup | Implemented. |
| evalScript | Existing Engine and host script evaluator | Implemented. |
| bunBuiltinNames | Generated upstream registry names | Implemented. |
| bunBuiltinHookName | Generated JS2Native dispatch names | Implemented. |
| bunBuiltinErrorCode | Bun's error-code ordering, including alternate constructors | Implemented. |
| isPromise, isProxy, isError | Existing Engine methods through engine_natives.rs | Implemented. |
| Bun JS2Native IDs 0 through 235 | Generated names in catalog.json | Stubs. Function invocation or binding-object initialization throws ERR_BUN_BUILTIN_UNSUPPORTED with the ID and upstream symbol. |

The catalog is the complete hook inventory. The following groups block the next module switches.

| Modules | Blocking hooks or behavior |
| --- | --- |
| events | Native validators 45 through 57, shared uncaught-exception hook 29, Node error constructors, EventTarget integration, async resource hooks. |
| util, assert | Native comparison and assertion bindings, MIME bindings, validation and error construction. Local inspection already adapts Bun's inspector. |
| path | createNodePathBinding in Path.cpp. Bun's JavaScript is a binding wrapper; retaining the current path implementation is necessary until that native binding is ported. |
| url | Native URL and ICU bindings, parser and formatting hooks. |
| string_decoder | Native module NodeStringDecoder, not a src/js JavaScript module at this revision. |
| buffer | Native module NodeBuffer, with additional engine-specific allocation and encoding hooks. |
| stream | Native stream transfer and sink bindings, async context, validators, buffer dependency. |
| timers | Shared native hooks and timer semantics. Existing timer natives can back the eventual adapter. |
| readline | Stream, terminal, native string-width and validator hooks. |
| fs, net, http, child_process | Native filesystem and socket bindings, streams, and process facilities. WASI host restrictions still apply. |

## Per-module status

| Module | Status | Reason |
| --- | --- | --- |
| internal:freelist | Bun's | Loader probe; no native hooks. Not a public Node module. |
| querystring | Bun's | Four focused upstream files pass on all engines, versus one before. |
| punycode | Bun's | The focused upstream file passes on all engines, versus zero before. |
| events | Blocked | Validators, Node errors, shared hooks, EventTarget and async resources. |
| util | Blocked | Native comparison, validation and MIME helpers. |
| assert | Blocked | Native assertion binding and Node errors. |
| path | Blocked | Path.cpp binding. |
| url | Blocked | URL and ICU native bindings. |
| string_decoder | Blocked | Native module, no engine-independent Bun JavaScript implementation. |
| buffer | Blocked | Native module and allocation bindings. |
| stream | Blocked | Native streams and dependencies. |
| timers | Ours | Shared-hook and behavior comparison pending. |
| readline | Blocked | Stream and terminal dependencies. |
| Remaining public modules | Ours | Not switched by the loader mechanism. |

## Verification

`scripts/generate-bun-builtins.sh --check` repeats Bun's codegen and checks the committed generated outputs. `scripts/test-bun-builtins.sh` runs the generated FreeList factory and loader behavior on all three actual engines. It checks lazy initialization, identity, independent runtime caches, failed initialization retry, cycles, private symbols, direct property writes, intrinsic call immunity, and explicit failures for unavailable intrinsics and native hooks. Its injected native table isolates the loader. `scripts/bun-builtins-node.py` separately runs the upstream Node assertion scripts omitted by the bun:test filename census. `--isolated-common` supplies an empty common-module fixture for these five files, whose common imports are unused, to measure their assertions despite unrelated Node test-harness dependencies. It does not count as an unchanged full-harness suite pass. The Rust test `generated_builtins_use_shared_data_natives` calls the actual shared native table, including source lookup and invalid-ID errors. It would fail if these hooks were installed only in an engine-specific bootstrap. The public-module fixtures in the next PR exercise the complete lookup, evaluator, and module cache on each engine.

`scripts/measure-bun-builtins.py --before <old-dist> --after <new-dist> --output <report.json>` records byte sizes, gzip sizes, artifact hashes, and the raw startup samples. Run it through the host's benchmark slot. Size, startup, upstream-suite comparisons, and gate results are recorded per PR. A passing fixture suite does not establish Bun's entire upstream compatibility.

## Loader mechanism measurements

The loader-only artifact passes 89 of 89 runtime fixtures on each engine. The generated FreeList and loader checks pass on all three engines. Web verification passes its 16 unit tests, local networking and registry checks, Chromium and WebKit checks, and all six HMR engine/browser combinations. Public modules are unchanged in this PR.

Before artifacts are rebuilt from main at 78e0ff8. After artifacts add this loader mechanism. Both use the same private Bun worktree with the repository's existing patch 0009 applied. The shared vendor was missing that patch at lane start. No new upstream patch was created. The private vendor uses the shared generated build options read-only.

Startup is wall time for an empty `-e 0` process. Seven sequential runs use wasmtime for QuickJS and JSC, and Node's host engine for browser. The first run is discarded. The table reports the median of the remaining six on this shared host. Small timing differences do not establish a speed improvement.

| Engine | Wasm bytes before | Wasm bytes after | Gzip-9 bytes before | Gzip-9 bytes after | Startup median ms before | Startup median ms after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| quickjs | 10,867,217 | 10,903,625 | 3,818,700 | 3,830,428 | 58.38 | 59.28 |
| jsc | 46,231,974 | 46,269,095 | 12,858,478 | 12,871,492 | 171.52 | 170.51 |
| browser | 10,145,021 | 10,179,703 | 3,523,665 | 3,532,793 | 72.41 | 73.34 |

Raw samples, artifact hashes, upstream results, command logs, and cleanup evidence are retained in `/work/reports/bun-wasm-builtins/` for coordinator review.

## First public module batch

The first batch replaces the local querystring implementation and incomplete punycode stub with Bun's generated modules. Both load lazily and require no native JS2Native hooks. Querystring reuses the runtime's Buffer implementation and the adapter's URIError constructor. Punycode uses portable string operations and RangeError.

The two public fixtures pass after an explicit garbage collection and verify CJS/ESM export identity. The complete runtime fixture suite passes 91/91 on each engine. Generated loader checks, web checks, the site build, and all six browser/engine HMR combinations pass.

### Module coverage

The upstream Node assertion files are omitted by the standard bun:test filename census. `scripts/bun-builtins-node.py` runs them unchanged. The focused comparison uses `--isolated-common`, replacing only their unused common import with an empty module. These results measure module assertions, not the complete upstream harness.

| Module | QuickJS before → after | JSC before → after | Browser before → after |
| --- | --- | --- | --- |
| querystring | 1/4 → 4/4 | 1/4 → 4/4 | 1/4 → 4/4 |
| punycode | 0/1 → 1/1 | 0/1 → 1/1 | 0/1 → 1/1 |

The unchanged common harness remains 0/5 on all engines, before and after, because node:net lacks getDefaultAutoSelectFamilyAttemptTimeout. Its failure is retained separately. No raw Node script is counted as a standard bun:test census pass.

The standard 30-file slice covers related URL behavior, events, util/parse_args, and assert. Counts below compare the rebuilt current main with the completed batch. Existing failures remain; there are no per-file pass-count regressions.

| Engine | Fully passing files before → after | Assertions passing | Failing | Errors | Timeouts |
| --- | --- | --- | --- | --- | --- |
| quickjs | 10/30 → 10/30 | 798 → 798 | 140 → 140 | 1 → 1 | 1 → 1 |
| jsc | 10/30 → 10/30 | 754 → 754 | 141 → 141 | 2 → 2 | 1 → 1 |
| browser | 10/30 → 10/30 | 800 → 800 | 141 → 141 | 1 → 1 | 0 → 0 |

Reproduce through the heavy wrapper with these commands for each engine:

```sh
python3 scripts/bun-builtins-node.py --engine <engine> --isolated-common --output <fresh-focused.json>
python3 scripts/bun-builtins-node.py --engine <engine> --output <fresh-full-harness.json>
scripts/bun-suite.sh --engine <engine> --network loopback --jobs 1 --launcher "$CARGO_TARGET_DIR/release/bun-wasm" --dependencies "$PWD/docs/bun-test-suite/dependencies/node_modules" --output <fresh-suite.json> js/node/url js/node/events js/node/util/parse_args js/node/assert
```

### Size and startup

These are sequential before/after measurements. Each median discards the first of seven startup samples. The timing differences include shared-host noise; this change makes no speedup claim. Factories parse only when required.

Historical querystring-only switch on the earlier main.

| Engine | Wasm bytes before → after | Gzip-9 bytes before → after | Empty startup median ms before → after |
| --- | --- | --- | --- |
| quickjs | 10,895,736 → 10,913,839 | 3,826,482 → 3,828,777 | 57.57 → 59.55 |
| jsc | 46,258,047 → 46,276,151 | 12,864,806 → 12,868,924 | 170.88 → 172.29 |
| browser | 10,173,649 → 10,191,874 | 3,530,946 → 3,532,886 | 71.70 → 71.17 |

Complete batch versus mechanism.

| Engine | Wasm bytes before → after | Gzip-9 bytes before → after | Empty startup median ms before → after |
| --- | --- | --- | --- |
| quickjs | 10,903,625 → 10,927,547 | 3,830,428 → 3,833,450 | 56.46 → 58.62 |
| jsc | 46,269,095 → 46,293,057 | 12,871,492 → 12,873,385 | 170.57 → 169.42 |
| browser | 10,179,703 → 10,203,739 | 3,532,793 → 3,536,518 | 71.40 → 74.23 |

Complete batch versus current main.

| Engine | Wasm bytes before → after | Gzip-9 bytes before → after | Empty startup median ms before → after |
| --- | --- | --- | --- |
| quickjs | 10,867,217 → 10,927,547 | 3,818,700 → 3,833,450 | 58.67 → 62.05 |
| jsc | 46,231,974 → 46,293,057 | 12,858,478 → 12,873,385 | 177.18 → 172.64 |
| browser | 10,145,021 → 10,203,739 | 3,523,665 → 3,536,518 | 72.00 → 70.62 |

First-import process startup includes the module require. Querystring compares its earlier isolated switch; punycode compares the current mechanism with the completed batch.

| Module | Engine | Startup median ms before → after |
| --- | --- | --- |
| querystring | quickjs | 56.86 → 59.76 |
| querystring | jsc | 170.30 → 174.09 |
| querystring | browser | 69.24 → 71.57 |
| punycode | quickjs | 63.28 → 58.11 |
| punycode | jsc | 170.77 → 177.18 |
| punycode | browser | 70.75 → 74.40 |
