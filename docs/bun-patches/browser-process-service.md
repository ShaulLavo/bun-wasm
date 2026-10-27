## Browser process service

Class **Host feature**, **original adapters** in `waffle/proc/`,
`web/src/{bun-executor,bun-launcher,subprocess-broker,worker,runner,shared-fs}.ts`,
`web/src/engine-host.js`, `web/src/net/{host,trampoline}.ts`,
`web/scripts/{node-host,node-spawn,node-signals,node-process}.ts`, the `node-host.mjs` entry, `waffle/core/wasi.ts`,
`crates/bunwasm-host/src/{main,slots}.rs`,
`crates/bunwasm-host/src/process/{mod,descriptors,pipe,stdin,stdio,wasi}.rs`, and
`crates/bunwasm-runtime/src/{host,natives,lib}.rs` plus `src/js/spawn.ts` and `src/js/{process,bootstrap}.js`
and their runtime types. These implement this project's process contract; no upstream
implementation is copied into these original adapters. The separate original mutation hook in
the already-ported EventEmitter is classified under [Node event emitter](node-event-emitter.md#node-event-emitter).
Child creation, pipes, waits, jobs, kills and signals use mandatory `runtime_proc` imports,
not Bun process slots or an optional capability probe. Only the 14 networking slots remain,
at indices 0–13 (`docs/host-abi.md`); there is no separate signal slot.
The generic service shares compiled modules and keeps process ids separate from job ids.
The browser launcher selects an executable's guest adapter instead of inheriting the
spawning process's engine. A small reservation/activation bridge is separate from the
lazily loaded supervisor. All Bun process I/O uses the same process-owned descriptors and
pipe endpoints as other guests; no Bun-only pipe implementation remains.
The shared guest keeps executable names intact. `web/scripts/node-spawn.ts` and
`web/src/runner.ts` register `bun`, `node` and its `nodejs` CLI spelling at each
host's existing executable directories. Node creates matching marker files. The
alias selects the same engine module without rewriting argv, bypassing PATH or
admitting arbitrary executables. These are original adapter registrations over
the Waffle revision pinned in the package manifests, not a new process runtime.

Each process has per-signal default, ignored or handled dispositions. An unhandled SIGINT,
SIGTERM or SIGPIPE immediately selects its typed default outcome and revokes; only handled
signals queue for guest delivery and retain the guest's own exit status. Registration/removal
publish synchronously, and removing a pending handler to default takes that action immediately.
A 65-cell signal table couples disposition with a per-signal pending bit, preserving distinct
signals and clearing pending before once-listener removal. The mandatory `runtime_proc.signal`
import supplies registration, dequeue, fatal polling and self-signals. Cooperative guest event-loop turns
pump handlers without keeping an otherwise idle program alive. The original JS process adapter
initializes SIGPIPE as ignored to match observed Node 26.7.0 and Bun 1.4.2 behavior, with no upstream
implementation copied. Registering a SIGPIPE listener selects handled delivery and removing the
last listener restores default (including once listeners), matching both native runtimes.
Removing unrelated listeners preserves the initial ignored disposition. Generic host signal
controllers retain the preview1 default.
EPIPE remains catchable by the guest; an escaping EPIPE follows the ordinary uncaught-error path,
prints the error and exits 1. It does not synthesize SIGPIPE or consume pending signals, even when
a SIGPIPE listener exists. Physical host signals are forwarded separately. Plain preview1 guests retain default
SIGPIPE and its status 141. Typed signal decisions precede worker error hooks, which must not
relabel default signal death as an ordinary worker error. The Node host installs generic process
and signal imports alongside the networking slot dispatcher, guarded by process lifetime.
SIGKILL immediately records 137 and revokes before physical termination; it cannot be caught
or ignored. A shared atomic terminal-result primitive arbitrates guest completion, startup
failures and default actions, preserving the winning status and whether it came from an ordinary
exit or a signal. The native Wasmtime adapter also retains an immutable typed outcome: default
actions select immediately, while handled signals do not take the fatal cancellation path.
The original `runtime_proc.wait` adapter returns the immutable outcome kind and code on
every host; no child-pipe metadata selector remains. The guest allocates its two directional
worker control pipes through `runtime_proc.pipe` and binds their dynamically assigned child fds
in the spawn request. Native worker completion closes the incoming reader and
outgoing writer before publication, preserving EPIPE/EOF at the correct endpoints.
The shared Bun facade reads that selected kind
rather than guessing from status 143 or a prior kill request. Synchronous spawn error
paths also observe completion before reading the final kind; a forced-stop request is not
proof that signal death won. Worker receivers consult that typed kind before synthesizing
an ordinary uncaught-worker error. Native descriptor and network allocations check their handle ranges before creating
resources, returning EAGAIN at exhaustion instead of wrapping or routing a handle into
another service.
The native linker's original
`wasi_snapshot_preview1::proc_exit` adapter preserves ordinary exit codes 126–255, which
Wasmtime 39.0.2's standard preview-1 implementation rejects as traps. The upstream reference
is `bytecodealliance/wasmtime`, `crates/wasi/src/p1.rs` at
`f66a5b61465c937aba66d73cd5d82f763cc3074f`; no implementation is copied. The adapter
uses the launcher's existing byte-sized OS exit convention (for example, -1 becomes 255),
then returns Wasmtime's typed `I32Exit` so normal exits cannot be confused with traps or
negative child-control results. Root and child stores use the same linker setup. The browser
WASI adapter and host-JS engine exit adapter apply the same byte-sized convention before
publishing completion. Original tiny-Wasm and host-engine tests cover negative and oversized
values through the real exit path and child wait/final-signal transport. The original Rust `readStdin` adapter flushes buffered
stdout before blocking, so a parent's readiness-before-input handshake cannot deadlock.
These are original host protocol extensions, not copied upstream implementations.
Filesystem revocation no longer claims
that `Worker.terminate()` proves death: an original admission/critical-section guard in
`waffle/fs/{protocol,client,shared,service}.ts` proves host operations quiescent before lock
reaping and physical termination; an ordinary guest exit acknowledgement also proves quiescence.
Children use independent process revocation identities while
sharing the filesystem service's root revocation word. New browser fixtures and timing
harnesses are original test programs, not copies of the spike implementations.

The browser playground installs the private shared-object service on its page-owned Waffle
runtime. `web/src/runner.ts` gives browser-engine root workers a leased route, forwards the
executor's native `bun-shared-connect` message, closes late or mismatched ports, and releases the
route with the root worker. This is an original caller activation adapter; it does not change
Waffle's runtime or the public package adapter. The real Vitest 3.2.4 browser fixture exercises
the startup shared buffer and transferred `MessagePort` with `useAtomics=false`, and its ordinary
async test, thread-pool test, and intentional rejection all pass through the maintained app matrix.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`waffle/proc/`, browser and Bun process adapters](#browser-process-service) | Host feature | Original process supervisor, executable registry including nodejs, jobs, registered signal dispositions including Node/Bun's ignored SIGPIPE default, immutable final-kind query and byte-sized exit statuses. |
| [`web/src/main.ts`, `web/src/runner.ts`, shared-object root activation](#browser-process-service) | Host feature | Original page-owned runtime installation and per-root shared-object route activation, native connect acceptance, late-port rejection, and teardown; verified by the real browser Vitest worker pool. |

[Ledger scope and pinned revisions](scope.md).
