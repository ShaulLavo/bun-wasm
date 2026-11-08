# Namespaces imported by required ES modules

Class **Host feature**, **original adapter**. No upstream implementation is copied.

The browser engine converts synchronous `require(esm)` modules with Bun's bundler.
With every dependency external, upstream `src/js_printer/lib.rs` at
`9510e74152073d850a18758ca41114d8f214ffa6` emits
`__toESM(require(specifier), 1)` for static imports. The Node-mode flag makes the
complete required value the default, even when the dependency is itself an ES
module. Angular CLI reaches this through strip-ansi importing ansi-regex.

Patch `0025-wasm-preserve-namespaces-in-required-ES-module-impor.patch` adds a
scoped printer hook. Only the internal CLI `esm_to_cjs` adapter enables it.
Wrapped external static imports then call the fresh metadata parameter's
`requireNamespace` method. Explicit require calls, dynamic imports, ordinary
bundler output and upstream Node-mode CommonJS defaults remain unchanged.
`scripts/export-patches.sh` exports the private vendor branch's commit.

The original runtime adapter in `src/js/bootstrap.js` resolves the dependency
using import conditions. It returns cached ES exports directly. The original
TypeScript `src/js/require_namespace.ts` factory wraps genuine CommonJS values
with the complete exports as default and live named getters. Object and function
wrappers use a weak cache. This deliberately does not unwrap a CommonJS object's
`__esModule` marker, which does not make that file an ES module.

`web/tests/fixtures/require-esm-interop/` is an original actual-guest regression.
Both loader modes check default functions, named live exports, explicit required
namespace identity and real CommonJS default imports. Public builds before and
after the internal conversion must emit identical ordinary interop code. The
existing metadata regression remains separate and unchanged.

## Required split-engine namespaces

The original `src/js/require_esm_namespace.ts` adapter adds the inherited,
non-enumerable `__esModule` marker that native Bun exposes on required ES
namespaces. The split-engine `native.requireEsm` handoff uses a cached view with
live export getters. It never copies export values or mutates the engine's
namespace. Namespaces that already export `__esModule` return unchanged, including
false and undefined exports. CommonJS values and the browser's internal bundler
conversion do not use this adapter. The upstream reference remains Bun
`9510e74152073d850a18758ca41114d8f214ffa6`; no upstream source is copied.

`tests/fixtures/require-esm-namespace-marker/` exercises the actual QuickJS and
JavaScriptCore guests through the native fixture gate. It also checks the browser
guest as a control. The fixture covers default-function calls, cached identity,
live exports shared with dynamic import, named-only modules, explicit markers,
and unchanged CommonJS exports.
