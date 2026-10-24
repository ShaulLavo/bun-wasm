## Engine interruption

Class **Host feature**. The WebKit patch changes
`Source/JavaScriptCore/llint/{LowLevelInterpreter.asm,LLIntSlowPaths.cpp}` and
`Source/JavaScriptCore/runtime/VMTraps.h` at Bun's WebKit revision
`3d3257150c40a1aabdc5f8b48d5b33d0413674cb`. Single-threaded WASI cannot use a
watchdog thread to publish VM trap bits while JavaScript runs. A per-VM countdown
therefore polls the host every 1,024 ordinary C-loop trap points, including loop
backedges and function entries. The existing trap slow path saves the interpreter
PC and stack before polling; generic exception/unwind checks do not poll the host.
A true callback result requests JSC's distinguished uncatchable termination
exception. Fatal polling uses the same mandatory `runtime_proc.signal` import as
cooperative signal handling. This is a host extension, not an upstream bug.

Original adapters in `crates/bunwasm-runtime/src/{engine,engine_quickjs,engine_jsc,lib,host}.rs`,
`crates/bunwasm-jsc/{cpp/helpers.cpp,src/sys.rs}`,
`crates/bunwasm-host/src/{slots,process/stdio}.rs`, and `waffle/proc/abi.ts`
implement `(signal=0, mode=4)` through `runtime_proc.signal`. It observes fatal cancellation
without consuming the authoritative per-signal handled pending set. QuickJS
installs its public `JS_SetInterruptHandler` through rquickjs's interrupt API,
without changing upstream QuickJS, amortizing host calls across eight ordinary
engine polls (about 80,000 backedges/calls). Neither engine callback enters JS.

Handled signals wait for the next ordinary event-loop turn, matching Node. Dispatching
them inside engine callbacks is not possible because QuickJS also polls during
native regexp operations, and reentry can break native borrowed state or runtime
timer invariants. No interpreter-specific
reentry hook or runtime critical-section suppression is needed. The original
`crates/bunwasm-runtime/src/js/{process.js,process_signals.ts}` adapter serializes cooperative dispatch,
including recursive broken-pipe handling. Default signals already have an
immutable host outcome; a fatal checkpoint unwinds Wasm without entering guest
catch/finally blocks, including while a handled callback is CPU-bound. The
browser-native engine needs no new hook and remains covered by worker termination.

The original `waffle/proc/abi.ts` adapter implements the same fatal-only mode 4
for generic process imports. The original `waffle/proc/signals.ts` helper preserves
pending-signal wake hints during cooperative dequeue. The original
`web/src/{runner,bun-executor,subprocess-broker}.ts` adapters use the process's
shared signal state and Waffle worker transport. Signal delivery wakes the process client
and the directory used by process polling; short timeout rescans are not the signal
notification mechanism. Cooperative dequeue consumes its wake hint without consuming
another pending signal.

These adapters and the browser proof/benchmark harness are original implementations,
not copied source. JSC polling covers JS safe points, not a single uninterrupted
native operation; QuickJS retains its existing native-operation interrupt polls.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, C-loop host interruption](#engine-interruption) | Host feature | Poll the process host at saved interpreter trap points; preserve native uncatchable termination. |
| [Engine signal adapters](#engine-interruption) | Host feature | Original QuickJS/JSC callbacks poll fatal cancellation without entering JS; handled signals stay pending for ordinary event-loop delivery. |
