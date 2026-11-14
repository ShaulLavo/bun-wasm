# JSC iterative JSON fast stringifier

Class **Port**. The upstream source is Bun's WebKit fork at
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`, especially
`Source/JavaScriptCore/runtime/JSONObject.cpp`, `PropertyTable.h`, `Structure.h`, and `VM.h`.

On WASI, the plain JSON fast path no longer recurses through native object and array frames.
`FastStringifier` owns a geometrically grown vector of container frames and a marked vector of
live cells. Object frames retain their property table and resume by physical entry index. Array
frames retain their opening length and re-read element storage for every step. The existing
1024-byte reservation and soft-stack check remain at `append` entry, but now run at constant
native depth.

Only the root `append` specialization starts the drain. Nested appends use a separate
compile-time specialization that opens a container without starting another drain. This
removes the hot traversal's recursive call graph and its per-container `m_draining` test.
The test-only resume accounting is a separate helper with guard returns.
Container checks, reservation, opening, advancement, and closing stay inline on the hot
path. A frame index comes from the nonempty drain stack and remains valid across a push;
the accessor reloads vector storage and checks that invariant in debug builds. Publication
uses the capacity already reserved before opening the container. A pop shrinks its roots
once. Property enumeration tests for descent only after a value can push a frame.

A container opens only after frame and root capacity succeed. Frame growth uses fallible vector
reservation, and root growth records overflow. The 4096-frame nesting cap and either allocation
refusal restart the existing general `Stringifier` from the root. The fast path runs no JavaScript,
so this restart preserves effect order and the general path remains responsible for cycles and the
unchanged 40000-holder limit. Each attempt destroys its frames, roots, and observer callback before
another attempt or the general path starts.

`PropertyTable::forEachPropertyFrom` is the resumable form of the existing physical table walk.
`Structure::acquirePropertyTableForJSONFastPath` is a WASI-only public wrapper around the private
table materializer. Its result is rooted immediately. Collection is not deferred. The test-only
cache query lets the controls prove that a live rooted table survives after its structure stops
caching it.

The WASI-only `WASIJSONFastTest` control records attempts, growth, refusal state, materialization,
and real `HeapObserver` collection callbacks. It can refuse one real frame or root growth and force
full collections immediately before table rooting and after frame publication. The default mode
leaves ordinary serialization without test output. Non-WASI builds retain the original recursive
implementation.

Original adapters, none of which retains upstream implementation code:

- `crates/bunwasm-jsc/cpp/helpers.cpp` strictly parses `BUN_WASM_JSC_JSON_FAST_TEST` and reports
  existing JSC telemetry plus the core allocator sample when the control is active.
- `scripts/jsc-json-fast-controls.test.ts` owns the launcher cases and their embedded sources.
  `checks/runtime-json-fast-controls.json` assigns it to the blocking runtime owner.
- `tests/fixtures/json-fast-iterative` compares ordinary and forced-general results on all engines.
  `checks/native-json-fast-iterative.json` assigns that fixture to the native owner.
- `scripts/bench-jsc-json.ts` measures pinned, alternating donor and candidate products.
  Its guest fixture warms up, then waits for stdin at both boundaries of the serialization
  loop. Linux per-thread CPU counters exclude compilation, startup, and waiting. Every
  measured loop must consume at least one CPU second, and the median ratio must not exceed 1.03.

The original `stack-getter-headroom` fixture and its 200000-deep `jsonplain` assertion remain
unchanged. Stack budgets, output limits, and the general serializer's recursion limit are unchanged.
