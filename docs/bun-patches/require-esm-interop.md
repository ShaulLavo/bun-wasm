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
