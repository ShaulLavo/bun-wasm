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

A regexp match reaches no trap point while it backtracks, and on wasm32 JSC has no
Yarr JIT, so every match runs in the Yarr bytecode interpreter. A second section of the
same patch changes `Source/JavaScriptCore/yarr/{Yarr.h,YarrInterpreter.h,YarrInterpreter.cpp}`,
`Source/JavaScriptCore/runtime/RegExpInlines.h` and `Source/JavaScriptCore/runtime/VMTraps.h`
at the same revision. The interpreter decrements a countdown at its single
`backtrack:` label, which every repeated attempt passes through, nested or not, and
calls an optional poll every 16,384 steps. The countdown lives on the compiled
`BytecodePattern`, not on one match: a polled match first counts its own start as a step,
loads the pattern's countdown and stores what is left when it returns. A global
`String.prototype.replace`, `split` or `match` loops over matches in C++ without reaching a
trap point, so a per-match countdown that restarted every time let millions of cheap
matches (each under 16,384 backtracks, or with none at all) run without ever polling. A
`BytecodePattern` belongs to one `RegExp` of one VM, and only the VM thread passes a poll, so
the field needs no synchronization; matches without a poll leave it untouched. Literal
patterns that JSC replaces with a plain string search never enter Yarr and stay one bounded
linear pass, like other single native operations. `RegExp::matchInlineOnce` supplies a
poll only on the VM thread, with a global object, when the host enabled the C-loop
countdown; the poll returns false while traps or termination are deferred and otherwise
asks the same `shouldInterruptScriptBeforeTimeout` callback as the trap slow path. A
true result abandons the match with the WASI-only `JSRegExpResult::ErrorInterrupted`,
which `matchInlineOnce` turns into `notifyNeedTermination()` and
`throwTerminationExceptionIfNeeded()`: the same uncatchable termination exception, so no
guest `catch` or `finally` runs. The alternative, ticking the C-loop trap countdown
inside Yarr, would hand the interpreter the VM and the trap slow path's frame state for
no benefit, since the poll needs neither. Hosts that never enable polling, and the
`jsc` shell, pay one decrement and a never-taken branch per backtrack. Against a control built
from the same tree without this section, ordinary and backtracking-heavy regexps ran within
run-to-run noise, and a looping catastrophic regexp stops in 5 to 16 ms after a page SIGKILL.

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
not copied source. JSC polling covers JS safe points and Yarr backtracking, not other
single uninterrupted native operations; QuickJS retains its existing native-operation
interrupt polls.

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
stop while the guest is inside one catastrophically backtracking regexp call (about 2^32
backtracks, inside an inner `catch {}`), far longer than any proof waits on any machine.
The stop can only land inside that call; if the call ever returned, the finally block and
the code after it would write their markers. The guest writes its readiness before the
call, so the proof does not depend on machine speed. It runs only for engines that poll
inside their native matcher, listed in `nativePollingEngines`: QuickJS's regexp engine
calls the interrupt handler, JSC's Yarr interpreter polls every 16,384 backtracks and
SpiderMonkey's irregexp every 8,192, so all three paired engines run it.

The original `runtimeProcess-page-SIGKILL-stops-guest-in-global-regexp-replace` proof makes the
same stop inside one `'a'.repeat(1<<22).replace(/(?:a|a){0,10}b|a/g, '')`. Every match costs a
few thousand backtracks, under any per-match interval, and the call runs for about 500 seconds
under the native launcher, so only a countdown that persists across matches can stop it. Against
main's JSC this proof fails (the guest never unwinds) while every other proof passes. It runs for
`nativeMatchesPollingEngines`: JSC, whose countdown now lives on the pattern, and SpiderMonkey,
whose global replace loop is self-hosted JavaScript with ordinary interrupt checks. QuickJS has
the same per-match restart in `lre_exec` and does not stop in this proof yet.

The stop proofs run last, in a separate page (`?phase=busy`) that the runner opens in a
fresh browser context after the main matrix's context has closed, and closes right after.
A busy guest that ever outlived its proof would keep spinning in its page's process and
starve every later case. A stop proof that fails after its guest started still kills that
guest and waits for its own poll to unwind it before the next case. The runner merges both
pages into one result, which is green only if both are.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`jsc/webkit-wasi.patch`, C-loop host interruption](#engine-interruption) | Host feature | Poll the process host at saved interpreter trap points; preserve native uncatchable termination. |
| [`jsc/webkit-wasi.patch`, Yarr host interruption](#engine-interruption) | Host feature | Poll the same host callback every 16,384 Yarr interpreter backtracks or match starts, counted per compiled pattern across matches; a stop becomes the uncatchable termination exception. |
| [Engine signal adapters](#engine-interruption) | Host feature | Original QuickJS/JSC callbacks poll fatal cancellation without entering JS; handled signals stay pending for ordinary event-loop delivery. |

[Ledger scope and pinned revisions](scope.md).

The original browser harness now accepts an explicit QuickJS/JSC subset through
its driver option, page query and controller. Its local default remains both
pairs; `interruptionProofs` in `web/tests/engine-interruption-cases.ts` is the one list of
named checks, and the gate and its unit tests count from it.
SpiderMonkey is outside the coverage catalogue, so a local driver run includes it only when
selected explicitly (`--engines=quickjs,jsc,spidermonkey` with a staged `bun-spidermonkey.wasm`
and `spidermonkey-engine.wasm`); it then runs the same paired-engine cases. In CI, both native
producers already build the ordinary SpiderMonkey pair before the browser-guest site, and the
site serves it gzipped like every other program. `scripts/browser-guest-coverage.ts` checks the
served pair against the producer's pair receipt and that the pair was built from the same
checkout, then copies only the receipt and its inputs into the interruption bundle
(`interruption/spidermonkey/`), so the artifact carries the programs once. The browser-guest
consumer decodes the site's copies, checks them against the served identity maps and the receipt
again, stages them with the other guests and adds SpiderMonkey to the selected engines. The job
sets `BUN_WASM_INTERRUPTION_SPIDERMONKEY=required`, so a bundle without the receipts fails the
interruption batch rather than silently dropping SpiderMonkey. Changes under `spidermonkey/`, the
SpiderMonkey build scripts and the pair receipt select this batch on pull requests;
`crates/` already selects every batch. No new SpiderMonkey build runs for this.
Every subset retains the two Browser fatal checks and both Preview1 clock
controls. Artifact preflight requires the selected pairs and Browser core;
result admission checks the exact selected names and routes, including both
sleepSync SIGUSR1 outcomes. This changes test selection only, with no upstream
patch, runtime, engine or functional assertion changes.
