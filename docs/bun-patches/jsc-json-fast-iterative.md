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
once. Property enumeration tests for descent after the generic value append. Its callback
keeps the rooted container and structure cells, while the parent cursor is stored by frame
index after descent. The physical table walk uses a local entry pointer and returns its next
index. Output positions and finished-frame counts are cached across buffer stores.
The property-name helper reuses the comma decision made before buffer reservation.

Root publication and table acquisition are inlined at their JSON call sites, retaining
`MarkedVector` registration and overflow handling. Fixed leaf output is forced inline only
on WASI. The existing buffer checks, stack reservations, and failure order stay intact.

The WASI append specialization checks native stack headroom at traversal entry.
Nested values run at constant native depth, so they reuse that check. Each append
keeps its fixed shadow-stack reservation. Non-WASI recursion keeps its per-value
headroom checks.

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
  `checks/runtime-json-fast-controls.json` assigns it to the blocking runtime owner. It follows the
  native job's `INSTALL_ENGINES` selection, so compiled controls run whenever JSC is selected.
  The controls and benchmark paths select JSC without building it for unrelated native changes.
  Recovery controls record the cold baseline and each of three pressure peaks and post-GC readings.
  Recovered heap and allocator live bytes stay within 8 MiB of their own cold baseline, allowing
  one-time JSC table and arena allocation. Later recovered readings may grow by at most 256 KiB
  from the first recovered reading. Neither bound scales with unrelated startup allocations or
  ballast. A 384 KiB buffer retained after the first cycle proves that the growth check fails.
- `tests/fixtures/json-fast-iterative` compares ordinary and forced-general results on all engines.
  `checks/native-json-fast-iterative.json` assigns that fixture to the native owner.
  Its deep comparisons use 4100 levels to cross the 4096-frame fast-path cap without repeating
  QuickJS's quadratic ancestor scans at 39999 levels. The JSC-only controls retain the
  39998, 39999 and 40000 boundary cases; the shared fixture's 4094 through 4097 cases remain unchanged.
- `scripts/bench-jsc-json.ts` measures pinned, alternating donor and candidate products.
  `scripts/fixtures/jsc-json-bench.ts` warms up, then waits for stdin at both boundaries of the serialization
  loop. Linux per-thread CPU counters exclude compilation, startup, and waiting. Every
  measured loop must consume at least one CPU second, and the median ratio must not exceed 1.03.
- `crates/bunwasm-host/src/main.rs` names the guest thread uniquely for direct counter selection.

The original `stack-getter-headroom` fixture and its 200000-deep `jsonplain` assertion remain
unchanged. Stack budgets, output limits, and the general serializer's recursion limit are unchanged.
