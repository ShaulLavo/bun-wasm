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

## Canonical native namespaces

Classification: Host feature for the upstream QuickJS change. Original adapters
for the JSC embedding, engine brand bridge, and runtime bootstrap.

Upstream references are rquickjs-sys 0.13.0's bundled QuickJS-ng 0.16.2
`quickjs.c`, Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`, and Bun at
`9510e74152073d850a18758ca41114d8f214ffa6`. No new upstream source is copied.

- `third_party/rquickjs-sys/quickjs/quickjs.c` gives `JS_CLASS_MODULE_NS` a
  null-rooted prototype with a non-enumerable `__esModule=true` marker. The
  namespace's exotic `has_property` checks own exports first, then that prototype.
  `JS_bunwasm_IsModuleNamespace` checks the internal class ID without consulting
  user properties or Proxy traps. Module creation and caching stay unchanged.
- `crates/bunwasm-jsc/cpp/helpers.cpp` sets the global's initial
  `moduleNamespaceObjectStructure` prototype before any modules load. Its brand
  helper uses `JSModuleNamespaceObject`, without patching WebKit source.
- The original Rust engine adapters expose the brand check through
  `Engine::is_module_namespace`. An unsupported engine returns `None`, not false.
  The shared native bridge returns undefined for that capability, and bootstrap
  preserves the existing Browser, SpiderMonkey and Hermes recognition predicate.
  QuickJS and JSC instead use their genuine native brand checks.
- Bootstrap caches `native.requireEsm` directly. The former require-only getter
  surrogate is removed because it changed identity and lost the engine brand.

Default, named-only and empty canonical namespaces inherit the marker. Explicit
`__esModule` exports override it and remain live, including false and undefined.
Require, static import, dynamic import and namespace reexports keep the same VM
object. CommonJS exports and browser bundler conversion remain unchanged.

Native Bun 1.4.4 adds its prototype marker when a namespace is first required.
This adapter installs the prototype at creation, so an import-only native guest
also sees the marker. Identity, enumerability and explicit-export behavior match
the control after require.

`tests/fixtures/require-esm-namespace-marker/` runs on actual QuickJS and JSC
through the native fixture gate and existing JSC web-guest group. It covers
live exports, all import orders, namespace reexports, markers, reflection and
negative brand controls, including borrowed prototypes and proxies. Existing
browser interop, metadata and public-bundler controls remain separate.
