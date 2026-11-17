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

The original `web/tests/engine-interruption-stop.ts` proof adapter holds a requested
native stop pending until the production bootstrap has returned and its genuine
terminal exit message has crossed the worker's FIFO channel. Only then does it
acknowledge genuine guest/bootstrap execution quiescence. The host Worker scaffold
remains physically alive until explicit teardown, so the original assertions still prove native termination did
not produce the unwind. Returning immediately from a suppressed terminate
would expire Waffle's observation lease while the guest was still unwinding,
preventing the terminal message that the proof requires. Failed-proof teardown
forces native stop before awaiting broker disposal, without setting either proof
event or altering the guest evidence. Signal delivery, synchronous sleep, guest
assertions and the terminal FIFO barrier are unchanged. This adapter is original
test infrastructure, with no upstream source or revision.

The original `runtimeProcess-page-SIGKILL-stops-busy-guest` proof stops a guest
spinning in `while (true) {}` the way Waffle stops any process: a page `kill(pid, 9)`
publishes the signaled outcome, then the broker calls `Worker.terminate()`. Real iOS
Safari does not stop a worker running Wasm on `terminate()` (a terminated busy group
member kept running for at least 60 seconds), so for QuickJS, JSC and SpiderMonkey the
proof keeps native terminate disabled: the engine's own mode 4 checkpoint must unwind
`_start` with the typed SIGKILL, run no catch, finally or later code, and make no
further checkpoint calls afterwards, and the page must observe exit status 137. The
Browser engine's guest JavaScript is the browser's own, so its terminate is real; the
guest posts a `SharedArrayBuffer` heartbeat to the page once with the worker's native
`postMessage` (Bun's runtime replaces `BroadcastChannel`), the page's observed worker
consumes that test-only message before the broker sees it, and the proof requires the
heartbeat to stop after `terminate()`. Returning a stopped member's group
pages depends on Waffle's per-incarnation exit lock, which is not in the pinned Waffle
release yet; this proof covers the stop and the exit, not page reuse.

The original `runtimeProcess-page-SIGKILL-stops-guest-in-native-regexp` proof repeats that
stop while the guest loops on a catastrophically backtracking regexp (each call backtracks
about 2^24 times) inside an inner `catch {}`. It runs only for engines that poll inside their
native matcher, listed in `nativePollingEngines`: QuickJS's regexp engine calls the interrupt
handler, so the stop lands in milliseconds although one call takes hundreds. JSC's Yarr
interpreter and SpiderMonkey's irregexp do not poll yet (one call takes about 1.7 s and
1.4 s, and their interpreter countdowns are hundreds of calls away), so both are excluded
until their matchers poll.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, C-loop host interruption](#engine-interruption) | Host feature | Poll the process host at saved interpreter trap points; preserve native uncatchable termination. |
| [Engine signal adapters](#engine-interruption) | Host feature | Original QuickJS/JSC callbacks poll fatal cancellation without entering JS; handled signals stay pending for ordinary event-loop delivery. |

[Ledger scope and pinned revisions](scope.md).

The original browser harness now accepts an explicit QuickJS/JSC subset through
its driver option, page query and controller. Its local default remains both
pairs, with 36 named checks per browser and 108 checks over the three browsers.
SpiderMonkey joins only when selected explicitly (`--engines=quickjs,jsc,spidermonkey`
with a staged `bun-spidermonkey.wasm` and `spidermonkey-engine.wasm`), because the CI
interruption job builds no SpiderMonkey pair; it then runs the same paired-engine cases.
Every subset retains the two Browser fatal checks and both Preview1 clock
controls. Artifact preflight requires the selected pairs and Browser core;
result admission checks the exact selected names and routes, including both
sleepSync SIGUSR1 outcomes. This changes test selection only, with no upstream
patch, runtime, engine or functional assertion changes.
