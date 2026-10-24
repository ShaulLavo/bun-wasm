## QuickJS data conversion

`engine_quickjs.rs::to_val` is an original adapter over rquickjs 0.13.0 and the
vendored QuickJS-ng API. No upstream source is copied. The adapter now checks
`JS_bunwasm_IsArrayBufferLike` before `ArrayBuffer::from_object`. The latter calls the throwing
`JS_GetArrayBuffer` getter even for non-buffer objects and leaves a TypeError
pending while returning None. Ordinary arrays and objects must cross the native
boundary without creating an exception. Native Rust tests also require the
WASI-only import in the original `host.rs` adapter to be target-gated; native
builds report that import route unsupported rather than linking a WASI symbol. The import-selector regression exposed
this on QuickJS; a native Rust regression also observes the pending exception.
The original helper added to `third_party/rquickjs-sys/quickjs/quickjs.c` checks
both ArrayBuffer and SharedArrayBuffer class tags without invoking a getter.
QuickJS's existing `JS_IsArrayBuffer` recognizes only the first class, so using it
alone would lose the shared-buffer conversion that the getter already supports.
`JS_bunwasm_IsDetachableArrayBuffer` is another original inspection helper. It
checks the ordinary-buffer class and detached flag before a transfer mutates any
buffer. It copies no upstream implementation.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, buffer tags](#quickjs-data-conversion) | Host feature | Query ordinary and shared buffer classes without throwing. |
| [`crates/bunwasm-runtime/src/engine_quickjs.rs`, data conversion; `host.rs`, native-test import gate](#quickjs-data-conversion) | Host feature | Original adapter checks buffer tags before calling a throwing getter. |
| [`third_party/rquickjs-sys/quickjs/quickjs.c`, buffer tag predicate](#quickjs-data-conversion) | Host feature | Original nonthrowing class query for ordinary and shared buffers. |

[Ledger scope and pinned revisions](scope.md).
