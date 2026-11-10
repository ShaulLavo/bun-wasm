## Module registration loader

Class **Host feature**. The registration pass and loader are original bun-wasm adapters, written against Bun's parser and ECMA-262 section 16.2.1.5. No engine implementation was copied. This ports the retained bun-wasm implementation from `74a1297868e397e820c390b8c49ae734fbdef2d6` to the paired core.

`crates/bunwasm-transpiler/src/register.rs` removes import and export statements from the parsed module. Imported names print as live namespace reads. Each exported local becomes one getter, an own property even when named `__proto__`, and the record lists every local export with its local binding (`e`), so the loader resolves two export names of one local to one binding. Re-exports and star exports become record data. Every identifier the record adds is allocated against the module's own declarations, references and text ([0021](0021-registration-record-names.md)). The optional [0017 printer mode](0017-module-registration-printing.md) prints the body as a generator, with top-level await expressed as yield. A parse error or module early error is reported as a syntax error, which the browser host throws as a `SyntaxError`.

`crates/bunwasm-runtime/src/js/esm_loader.ts` links and evaluates the records. It tracks cycle roots, pending async dependencies, and async parents in evaluation order. Its factory accepts `resolve`, `load`, and `initMeta` callbacks. A loaded module is either a record or a synthetic namespace. Synthetic named exports snapshot enumerable values, while the host supplies the default export separately. Virtual eval names bypass resolution. Dynamic imports from classic scripts use the non-enumerable `__bunwasm_import` hook.

The core owns lowering, source maps, resolution, and source preparation. `ModuleHost` exposes the factory source, record loading, and script lowering to the engine adapter. Native ES module engines continue to use `load` and wrapper handoffs. Record mappings compose before the existing prologue and transpiler mappings.

The browser engine uses the same loader for every ES module of a process without a module store, which is every browser worker ([The browser engine](../engine-browser.md#es-modules-records-with-live-bindings)). `web/src/module-records.ts` prepares a graph level by level, evaluates each record as an `export default (…)` module from a `blob:` or `data:` URL so stack frames keep a script URL, and hands CommonJS, JSON, text and builtin keys to `require`. `crates/bunwasm-transpiler/src/record_fixup.rs` rewrites the printed global `arguments` to the loader's `ga()`/`gt()` reads and maps imported calls, which V8 reports at the argument list, back to the call.

The loader and `module-records.ts` capture the built-ins they use when they are created, after the promise-job wrapper and before user code; their promises settle with `undefined` through captured reactions, so no user-replaced `then` is looked up. The browser host's CommonJS and lazy polyfill evaluation uses the `eval` captured when the host loads. Once the process exits, nothing new loads, links or runs and nothing is fulfilled or rejected. Its namespace object is a Proxy over a sealed target with one writable, non-configurable data property per export, so descriptors, `Object.keys`, `in`, identity and TDZ errors match a native namespace. Named imports read accessors on an internal bindings object with an ordinary prototype, which V8 keeps in fast mode. Patch [0020](0020-registration-record-parsing.md) keeps module `this`, literal comparisons and anonymous defaults as written.

Known differences from native modules remain. `Function.prototype.toString` returns the printed record, with names and structure but not the file's formatting, comments or literal spelling. Assignment to a namespace import is not rejected as a module early error. On Node's V8, a named import read costs about five times a native one and a namespace property read about 45 times, because they go through an accessor and a Proxy trap. Imported calls cost about the same as native calls.

`scripts/esm-loader-*.ts` and `tests/fixtures/esm-loader/` compare the loader with Node. At test262 revision `0b4e0812022b18236b5276d2804948fdd9f71603`, the module-code run on Node reports 411 passes, no failures, 6 transform errors, and 182 skipped tests. The runner skips parse-negative tests (which the transpiler rejects instead) and transforms every reachable module eagerly, so a transform error is not a pass. The six are negative tests whose dependency fixtures are invalid (`instn-resolve-empty-export`, `-empty-import`, `-err-syntax-1`, `-err-syntax-2`, `-order-depth`, `-order-src`: phase resolution, type `SyntaxError`); the record parse rejects those dependencies with a syntax error before any module runs, which the browser host throws as a `SyntaxError`. `instn-local-bndng-const` (a `const` write inside a function, a run-time `TypeError`) passes: record parsing no longer reports `const` writes, which an ordinary Bun transpile and native Bun still reject. The 27 focused fixture cases pass, and `web/guest-tests/module-records.ts` runs the source review's controls on the actual browser guest with and without a module store.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-transpiler/src/register.rs`, `crates/bunwasm-runtime/src/js/esm_loader.ts`, and the paired source-preparation hooks | Host feature | Original adapters for live module bindings, cycles, top-level await, dynamic imports, and source maps on script engines. |
| `web/src/module-records.ts`, `crates/bunwasm-transpiler/src/record_fixup.rs`, and the `hostUseModuleRecords`/`hostModuleRecord` natives | Host feature | Original adapters that run every browser-engine ES module through the loader without a module store or service worker. |
| `scripts/esm-loader-*.ts`, `tests/fixtures/esm-loader/`, and the `transpile --register` example | Host feature | Original test harness and record regeneration tools restored from the coherent J1 handoff `2a12f721f58b7a4f461dd039c4ee50a5696ce9ad`; CI discovers the loader tests through `checks/quality-esm-loader.json`. |

[Ledger scope and pinned revisions](scope.md).

## Re-exported default imports

Bun's parser at `9510e74152073d850a18758ca41114d8f214ffa6`, in
`src/js_parser/scan/scan_imports.rs`, omits default imports from `named_imports`
when it does not bundle. The original registration adapter records these bindings
from import statements before it removes them, just as it records namespace
imports. An export clause referring to a default import becomes an indirect
export of the dependency's `default`, not a getter for an undeclared local.
The prepass also covers export clauses that appear before their imports.

This fixes wrappers such as eventemitter3's `import EventEmitter` followed by
`export { EventEmitter }`. It does not change CommonJS export snapshots or add
globals. The compiler regressions cover both export aliases and import order.
The discovered native fixture `tests/fixtures/default-import-reexport` checks
CommonJS constructor identity and live ES module default re-exports. An
`export default value` expression must still retain its evaluated snapshot.

The fixture's `.mjs` and `.cjs` files are deliberate JavaScript module-format
inputs, classified in `scripts/typescript-source-runtime-inputs.txt`, not host
helpers or new legacy-source exceptions.

## Runtime text requests

File preparation consumes explicit static text selectors before registration request
collection. A process-owned request table resolves those requests to distinct text
module names. The shared loader receives generated default-only ESM records, so a
text namespace cannot collide with the same file's ordinary HTMLBundle or CommonJS
cache. Compiler callbacks remain compiler-owned and their token bytes are copied
into the per-call AST arena. The direct re-export metadata correction is classified
separately in `0022-reexport-loader-selectors.md`.

`import_requests.ts` normalizes dynamic specifiers and options synchronously inside
a fresh import promise, before any deferred load. The bootstrap initializes the
record loader's captured helper without adding a Hermes factory-native method.
Browser record graph preparation and linking both use import-only resolution.
Default CommonJS resolution and the native module-host interface are unchanged.

This support applies to compiled file ESM and CommonJS. Generated Function/eval/vm
and require-of-ESM bundler paths are not qualified by these controls.

## File preparation error contracts

The runtime's semantic preparation pass carries the compiler's existing
`Syntax`/`Other` failure classification through the CLI adapter. Invalid module
source reaches the engine as `SyntaxError`; initialization and printer failures
remain `BuildError`. Public transpiler and bundler error contracts are unchanged.
Source-preserving file preparation uses the existing non-folding runtime parser
mode, including when text or dynamic-import lowering forces printing. That scan
must not turn a deferred write to a constant into a load-time build failure.
Native STORE evaluation still supplies the run-time `TypeError`; it is not routed
through registration records. No additional upstream patch is needed.

## Private hot sessions

The factory now separates process-lifetime intrinsic capture from session-owned
registries. `newSession` reuses those captured intrinsics without replacing the
ordinary generated-code import hook. Hot sessions use the same linking,
namespace, cycle, top-level-await and rejection algorithms. Their optional
import resolver preserves the existing options-aware process request boundary.
The hot controller omits settle-only host tracking because cancellation may
intentionally leave an import promise pending. This does not change ordinary
loader tracking. See [same-realm hot runs](server-hot-run.md).
