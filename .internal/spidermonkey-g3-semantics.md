# SpiderMonkey G3 semantics

Status: Approved source implementation. Native acceptance remains blocked.

## Boundary and throughput

The retained corrected checkpoint is `1a53e2123e4876be671a9a03eb025ae569795001`, tree `c494195936b4b23bfc8bef9fdcb624e513fa82e4`. This checkout fast-forwarded to it. Earlier author trees and native receipt roots remain read-only.

- Blocking first steps. Read the Engine trait and actual JSAPI implementations before editing. No Mozilla, core, side, or launcher build is authorized.
- Independent workstreams. Not applicable. The parent assigned one implementation worker and forbids helpers.
- Shared mutable state. Only the assigned shim, adapter, distinct tests, manifest, and semantics adapter record change. Host plumbing and measurements have separate owners.
- Smallest safe decomposition. One worker keeps module promises, callback ownership, and GC roots coherent across the existing boundary.

## Existing execution model

The shared program uses `Engine` to evaluate entry modules and classic CommonJS wrappers. SpiderMonkey's load hook delegates resolution and source loading to the existing `ModuleHost`. SpiderMonkey owns the microtask queue. The adapter captures an AsyncLocalStorage frame in each job callback's host-defined data and restores the caller's frame after running it. Rust retains unhandled promise identities until the shared program drains them. Native JS functions hold finalizable objects containing Rust registry IDs. External memory is user-owned, not engine-owned.

## Source decisions

Model the Domain keeps module stages in promise reactions and external-buffer identity in a weak collection. Fix Root Causes moves native closure destruction outside the registry borrow. Build the Lever adds rerunnable source controls and future runtime fixtures. Prove It Works means source and syntax checks cannot count as either-tier runtime acceptance.

Parallel architecture exploration and independent review are skipped under the explicit no-children worker brief. Opening a PR, pushing, merging, releasing, and deploying are also excluded. The parent reviews and integrates the committed delta.

## Implemented bounded delta

Module graph loading, evaluation, and namespace resolution now use ordered native promise reactions. Evaluation settlement is forwarded through internal reactions, never by returning the evaluation promise for public `then` adoption. Repeated compilation of a cached name preserves the first identity without a leaked root. Direct JavaScript dynamic import continues through SpiderMonkey's native load hook.

External-buffer identity now lives in a weak map, including after detach. Length pinning blocks direct built-in transfer, not just host checks. An unrelated detached buffer is rejected. Rust destroys finalized callbacks after releasing the registry borrow, and explicit GC drains the queue. The existing per-job async frame and promise rejection list are retained, with checkpoint cleanup and interruption guards added.

Native errors capture the original constructors. The shim selects V8 stack formatting. Missing-promise primitives reject safely. Exception-less interruption consumes the latched outcome, including failed property writes, instead of calling the host interrupt handler twice.

The exact named CommonJS wrapper recognized by `modules.rs` keeps its original named expression and declarative self binding. One synthetic header newline is removed before compilation at line zero, preserving the body bytes, line-one columns, formals and strict/sloppy recursive receivers. Other scripts keep their nonnegative starting line, including zero. Other negative source shapes explicitly fail. The coordinator accepted this bounded correction and kept arbitrary negative classic-script offsets open as a contract gap.

## Verification and remaining gates

The source suite includes an executable host control for exact wrapper recognition, unchanged body bytes, invalid negative shapes, and nonnegative dispatch. The original Rust finalizer code panicked with `RefCell already borrowed`; the corrected extracted routine permits destructor reentry. These are host controls, not SpiderMonkey execution.

The new C++ regression driver covers namespace identity, asynchronous dependency loading, top-level await, dynamic imports, interleaved async frames, handled and unhandled promise identities, native promise reactions, finalizer ownership, direct buffer transfer, repeated detach, native error constructors, CommonJS bindings and line diagnostics, nonnegative line zero, invalid negative shapes, primitive exceptions, stack overflow, and uncatchable interruption. It passes syntax-only compilation against retained headers. It has not been linked or executed.

A genuine host-target Clippy attempt stopped before compilation because the prepared checkout has no `vendor/bun/src/bun_alloc`. No dependency checkout, manifest change, build-script bypass, or implicit native build was used to work around it. Rust formatting and the extracted finalizer compilation pass, but full adapter metadata remains unverified in this checkout.

The parent must independently review the delta. After a separately authorized fresh N1 archive passes its existing verifier, run the driver and full hello, eval, modules, CommonJS, serve, and spawn cases as separate child processes with `BUN_WASM_SPIDERMONKEY_TIER=interp` and `pbl`. Bind evidence to the integrated source and real artifacts. General negative classic-script offsets remain unfinished. No source-only result here is a G3 pass.

The detailed evidence and final source identities are retained at `/work/reports/wave-20261101/engines/spidermonkey-g3/semantics/main-account/RESULT.md`. The parent owns this prepared checkout and the small report until integration or abandonment.
