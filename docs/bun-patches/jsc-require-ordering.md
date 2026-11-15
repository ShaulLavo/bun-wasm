# Synchronous JSC module loading

Classification: Host feature, original adapter. No upstream implementation is
copied or patched.

The JSC adapter uses Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. The reference APIs are
`Source/JavaScriptCore/runtime/JSModuleLoader.{h,cpp}`, `JSPromise.h` and
`ModuleRegistryEntry.h`. Bun's synchronous require binding is
`src/jsc/bindings/ZigGlobalObject.cpp`, `functionEsmLoadSync`, at
`9510e74152073d850a18758ca41114d8f214ffa6`.

`crates/bunwasm-jsc/cpp/helpers.cpp` adds an original `bunjsc_require` adapter
to the existing `JSModuleLoader::loadModuleSync`. WebKit drains loader
continuations in its synchronous queue while ordinary promise callbacks and
earlier dynamic imports remain in the normal queue. The prior adapter used
the asynchronous import operation for require, forcing the runtime to drain
unrelated jobs before the required graph could complete.

The adapter returns the registered record's canonical namespace through an
owned promise. Resolving that promise preserves the existing adoption of
namespace exports named `then`. A rejected load is returned with its original
reason and handled by the Rust require bridge. A still-pending asynchronous
graph retains the existing import operation on the same cached record, so its
eventual completion and rejection remain owned after require reports that it
cannot return an asynchronous module. The adapter does not replace or remove
module records.

The Rust FFI declaration and `Engine::require_module` implementation route only
synchronous require through the new adapter. Ordinary import, the event loop,
stack budgets and the shared Engine contract stay unchanged.

`tests/fixtures/require-esm-job-boundaries` checks the callback boundary, graph
order, shared dependency run count and namespace identity against native Bun.
The existing lowered-import fixture retains its native expected result.
