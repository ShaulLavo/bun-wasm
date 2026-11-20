# Numeric WebAssembly Global adapter

Classification: original host-feature adapter. No upstream implementation is
copied or patched by this change.

`crates/bunwasm-runtime/src/wasm.rs` and `src/js/webassembly.ts` implement the
[partial numeric Global contract](../webassembly-globals.md). The backend API
reference is the workspace's Wasmi 0.46.0, `third_party/wasmi/src/global.rs`.
The parity reference is Bun's `test/js/bun/test/jest-extended.test.js` at
`9510e74152073d850a18758ca41114d8f214ffa6`. Its numeric Global expressions use
`.value`; neither upstream assertions nor matcher helpers change here.

Constructors allocate real Wasmi Globals after descriptor and initial-value
conversion. A Store-qualified registry validates kind, backend, resource,
type and mutability. It records constructor origin as host authority, so aliases
and recreated wrappers cannot turn a constructor Global into an exported-origin
Global for unsupported cross-backend imports.

Original Wasm export indices identify declarations inside each unique runtime
instance. Imported declarations propagate the originating registry handle by
global import ordinal. Equal values never establish identity, and private backend
layout, hash keys and debug strings are never inspected. Scalar immutable imports
retain distinct declaration identities. Canonical JavaScript wrappers use weak
references and finalizers that do not retain their targets. Backend allocations
remain within the existing Store lifetime, including allocations from failed
instantiation that Wasmi cannot free individually.

The shared-memory compiler admission, host and numeric wire are unchanged.
Only immutable exported-origin numeric values use the pre-existing scalar path;
constructor origins reject before nested start effects. Reference transport,
nested mutable admission and common execution across backends remain deferred.

The new fixtures and source-bridge controls are original test code. They cover
numeric coercion and branding, live JS/Wasm sharing, two consumers, import-kind
interleaving, aliases and re-exports, equal distinct declarations, reentrant writes,
start traps, wrapper collection, retained storage, and malformed native handles.
The shared-group controls retain existing immutable exported-global assertions
and add constructor-origin rejection through ordinary re-exports for all four
numeric types.
