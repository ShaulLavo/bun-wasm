# QuickJS JSON ancestor bookkeeping

Class **Upstream bug**. The adapted code is `js_json_to_str` in
`third_party/rquickjs-sys/quickjs/quickjs.c`, from QuickJS-ng 0.16.2 bundled by
rquickjs-sys 0.13.0.

`JSON.stringify` keeps its ancestor list in a private JS array. The upstream
push uses ordinary property assignment when Array.prototype has indexed
properties. A user setter can intercept that assignment, observe the value,
throw, or prevent the ancestor from being recorded for cycle detection.

The local change defines an own configurable, writable, enumerable data property
at the current length with the existing `JS_DefinePropertyValueInt64` operation.
Defining an array index updates its length. The array remains owned by the
stringify context and holds the same duplicated value as the previous push.
The define operation consumes that duplicate on success and failure. Failure
uses the existing exception cleanup; the stringify context frees the whole
array when traversal aborts. Successful traversal uses the unchanged pop and
frees its returned reference. This preserves the GC roots and avoids an extra
container or a new allocator. Allocation refusal still propagates an exception.

The stack is private, extensible, and contains contiguous own data properties;
user code cannot replace its length, remove an entry, or change its prototype.
The existing includes and pop therefore read its own entries. No public array
operation or user-object getter, toJSON, or replacer invocation changes.

Original adapters: `tests/fixtures/json-private-stack/index.ts` exercises private
setter/getter counts, nested and shared values, cycles, reentrant getters and
replacers, toJSON, thrown values, and public array hooks. Its native manifest is
`checks/native-json-private-stack.json`. Native Rust checks in
`crates/bunwasm-engine-quickjs/src/json_tests.rs` run the same semantic fixture
directly in QuickJS and check GC during a replacer, allocation refusal, and
subsequent recovery.
