# SpiderMonkey Engine semantics adapter

## Classification

This is an original adapter, not copied Mozilla implementation. It changes
`crates/bunwasm-spidermonkey/cpp/engine.cpp` and
`crates/bunwasm-engine-spidermonkey/src/vm.rs`. The C ABI, Engine trait, native
profile, tiers, memory limit, and telemetry representation stay unchanged.
The existing integration is recorded in `spidermonkey-engine-program.md`.

The adapter targets `mozilla-firefox/firefox` revision
`a5df22d986d4b626f771b4f8885241941601c35c`. Its API inputs are
`js/public/Modules.h`, `Promise.h`, `WeakMap.h`, `Stack.h`,
`CompilationAndEvaluation.h`, `ArrayBuffer.h`, and
`experimental/TypedData.h`, and `RealmOptions.h`. Relevant implementation contracts were checked in
`js/src/vm/Modules.cpp`, `CompilationAndEvaluation.cpp`, `JSFunction.h`,
`ArrayBufferObject.cpp`, and `frontend/TokenStream.cpp`. No upstream file changes.

## Changes and reasons

- Module evaluation waits on `LoadRequestedModules` before linking and evaluating.
  Internal reactions forward evaluation settlement without adopting its promise
  through public `then`. Top-level import adds the namespace reaction afterward.
  Dynamic imports first load the imported module's dependency graph, then finish
  the import from an internal loading-promise reaction. Static graph loads finish
  directly. The opaque native payload is preserved. The earlier direct-path
  correction still linked a New module because it never loaded that graph.
  This sequence is adapted from `js/src/shell/ModuleLoader.cpp` at the same
  upstream revision, using a traced four-slot closure to retain the referrer,
  request, payload and module across the loading reaction. No shell path or
  filesystem implementation is copied. Cached module names retain
  one module identity instead of allocating an unused persistent root.
- Job callbacks retain their existing captured async frame. Draining stops on an
  exception or interruption, and checkpoint completion clears kept weak objects.
  Existing unhandled-rejection callbacks and the Rust pending list remain.
- Finalization still queues native IDs without allocating in the finalizer.
  Rust removes callbacks under the registry borrow, then destroys them after
  releasing that borrow. Explicit GC drains completed native finalizers too.
- User-owned buffers are length-pinned, so direct built-in transfer operations
  fail as well as the host transfer path. A private weak map preserves their
  identity after detachment without keeping unreachable buffers alive. Unrelated
  detached buffers are no longer accepted as host-owned memory.
- Classic scripts preserve nonnegative first lines, including zero. The exact
  runtime CommonJS wrapper with first line -1 keeps its original named function
  expression. Removing one synthetic header newline and compiling at line zero
  puts the unchanged body at line one, with its original columns. The declarative
  self binding preserves strict and sloppy recursive-call receivers and assignment
  behavior. No enclosing object or extra function is introduced.
- Other negative script shapes return a RangeError. Arbitrary signed classic
  offsets remain an unresolved Engine contract gap. Unsigned overflow and silent
  clamping are not substitutes for implementing that contract.
- Native errors retain their original built-in constructors despite replacement
  of globals. Stacks use the engine's native SpiderMonkey format to retain the `async*`
  allocation-ancestry boundary. The V8 formatter discards that metadata in
  `js/src/vm/SavedStacks.cpp`. `js/src/vm/AsyncFunction.cpp` attaches callers from
  promise allocation even for detached calls. A captured read-only internal formatter capability reads the actual
  SavedFrame parent and async-cause metadata, keeping names and sources separate.
  Text prefixes cannot establish async ancestry because display names are
  unescaped. The formatter therefore omits allocation ancestry only through the
  native metadata, while preserving synchronous computed-name and CommonJS
  callers. Custom stack text stays on the text parser. Raw `Error.stack` retains
  the ancestry. This does not add V8 CallSites or claim
  awaiting-caller reconstruction. Interruption consumes the
  latched engine outcome instead of polling the host again. Primitive inputs to
  native promise reactions return an error rather than dereferencing null.

- Realm creation enables SpiderMonkey's standard shared memory and Atomics APIs
  before creating the global. The JSAPI default disables both. Framework WASI
  bindings inspect and allocate SharedArrayBuffer within one guest, even without
  cross-process sharing. This does not enable guest-to-guest shared-memory
  transfer, add native threads, or change the program's Wasm memory profile.
  The existing `shared-array-buffer` fixture keeps its DataCloneError assertion.

## Evidence boundary

`scripts/spidermonkey-semantics.test.ts` has a feature-owned quality manifest.
It checks source structure and executes extracted host-only CommonJS recognition
and Rust finalizer logic. The Rust control uses the already installed stable
compiler through `rustup run stable`, which does not install a toolchain.
Both extracted controls compile during test module setup, before either
five-second runtime test starts. Compiler diagnostics and status still fail the
quality gate. Setup reads each compiled executable into a buffer, then removes
its scratch directory in `finally`. Each runtime test writes and executes those
bytes in its own scratch directory and removes it in `finally`. Filtering out
every test therefore leaves no setup outputs. No engine code or runtime
assertion changes.

`scripts/spidermonkey-semantics-setup.test.ts` runs disposable copies of that
same suite. Real C++ and Rust compiler wrappers each delay startup by six seconds,
then compile and execute the production extracts with the unchanged test deadline.
A second copy destroys callbacks while the registry is borrowed and must fail
with `RefCell already borrowed`. A failed compiler must also fail the suite.
Each control checks that child scratch is empty after success, failure, or a run
that filters out every test.
Both test files remain owned by the blocking quality gate.

`crates/bunwasm-spidermonkey/tests/engine-semantics.cpp` is a deferred native
regression driver. Its syntax is checked against retained headers, but it has not
been linked or run. It does not add a native build recipe or CI build demand.

The November 8 development runs reused the retained Unicode native archive and
rebuilt the side, core, and launcher. Both tiers passed twelve focused runtime
fixtures and the separate valid uncaught-error and TypeScript stack fixtures.
Dynamic graph controls, original error and rejection identity, and SavedFrame
controls passed. QuickJS, JSC, and actual Chromium passed seven focused shared
stack and IPC fixtures with their existing expectations. These results belong to
the experimental source at `62b9f8f848e2b4fc45ffbc7ddea9773d436ab0d7`, not a
claim that later source or a release producer has passed. The historical stack
review requested changes; its three fixes and subsequent runtime evidence do not
replace that review with a second approval. Full G3 and the direct C++ regression
executable remain unrun.

Value construction extracts array, object and property-write operations into
small helpers. Their order, temporary value ownership and rejected-property
error release remain unchanged. This keeps the conversion code within the
three-level nesting limit without changing its error behavior.
