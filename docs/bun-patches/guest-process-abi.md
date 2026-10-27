## Guest process ABI

`waffle/proc/abi.ts` is an original adapter implementing the process ABI specified in
[host ABI](../host-abi.md#process-imports), over this project's process, descriptor and filesystem services.
It is not copied from Bun, Node, WebKit, SLICC or another WASI host. Its packed subscription,
event and wait records are the project's own interface; the errno values follow WASI.
Spawn metadata copies the checked guest span into fixed-owned bytes before native UTF-8
decoding: TextDecoder's WebIDL input permits shared buffers, not resizable backing. This is
representation normalization, with no engine/version detection or retry.
`waffle/core/{descriptors,wasi}.ts` adds signed-success descriptor bounds, explicit immediate
terminal methods and notification-aware preview1 polling without replacing the existing
blocking preview1 I/O contract.

`waffle/fs/{client,shared}.ts` extends the original bun-wasm shared filesystem at revision
`9d072068` with nonblocking lock admission and asynchronous preparation for cold reads and
file growth. Preparing an operation never consumes input or commits a write behind EAGAIN.
The browser runner, worker and subprocess broker compose these original adapters lazily,
share one fd table with preview1; Bun's separate child-process slots have been removed.
`web/src/runtime-terminals.ts` is an original callback-destination codec: it preserves stdout
versus stderr across dup and remapped inherited fds, forwards generic child output to the run's
hooks, and represents this runner's default EOF stdin explicitly. After selecting the immutable
winning outcome, the process supervisor waits for the final ordered host acknowledgment before
confirming an ordinary exit and terminating its worker, so queued terminal output drains first;
fatal outcomes and explicit disposal still
complete without waiting for that acknowledgment. A late kill cannot bypass the drain after an
ordinary outcome has already won. Unknown callback terminals are rejected rather than pretending
their input can be shared. No new upstream patch, copied
implementation or compatibility branch is introduced.

The original executable lookup adapters in `js/spawn.ts`, `host.rs` and `natives.rs` share
`runtime_proc.access_start/access_take/access_cancel` between Bun.which and spawn. Lookup reads
live host metadata, searches inherited PATH in order, treats an empty entry as cwd, and never
rewrites slash-containing commands. PATH candidates are joined without resolving `.` or `..`,
so live admission still rejects missing or non-directory intermediate components before trying
the next entry. `scripts/spawn-path.test.ts` covers absolute and relative PATH components,
continued search, and the same errors for explicit commands. `src/executable-paths.ts` defines the persistent browser,
QuickJS and JSC bun/node paths used by the public installer and demo. Preview1 roots use their
explicit modules; recursive fixtures register their own absolute files. The public installer
now connects its reviewed file ownership/rollback implementation to `web/src/bun-launcher.ts`,
replacing the temporary process-unavailable boundary without copying upstream implementation.
Package-script/bunx argument normalization remains ahead of executable lookup.

The Bun guest's child-process adapter is original code over that ABI.
`crates/bunwasm-runtime/src/host.rs` declares the `runtime_proc` imports and `natives.rs` exposes
them as `procSpawn`, `procPipe`, `procRead`, `procWrite`, `procWait`, `procWaitJob`, `procKill`,
`procKillJob` and `procPoll`. `js/spawn.ts` (converted from the earlier `spawn.js` adapter) keeps
the Bun JSON and pipe metadata surface (`Bun.spawn`, `Bun.spawnSync`, `node:child_process`
wrappers, readable stream helpers, `maxBuffer`, `timeout`, `killSignal`) and now builds every
child from descriptor bindings and classifies outcomes only from typed `wait` results.
Caller-controlled stdin conversion and streaming validation run before descriptors or children
are allocated. Sink writes retain partial pipe data until the bounded writer drains, so Node
Writable write and final callbacks cannot report success before the child has received all queued
input; early EPIPE, explicit destruction and child failure settle those callbacks with an error.
A synchronous child that closes stdin early discards further input on EPIPE, while stdout/stderr
and the actual typed result continue to drain; Node Writable destruction closes the underlying
process writer so children observe EOF. Async Web streams and Node readable adapters only pull
when downstream demand exists and stop when `push()` returns false, while explicit
`text`/`bytes`/`arrayBuffer`/`json` capture helpers retain their own `maxBuffer` policy instead
of applying a lifetime limit to consumed streams. The capture helper accepts the undecorated Web
stream and returns the fixed-owned bytes from `concatBytes`; the local `runtime.d.ts` Writable
final callback declaration includes the optional error passed by the Node stream contract.
The Node adapter starts one demand-limited pump immediately, so unread empty streams observe
EOF without an application reader. After exit or startup failure, it resumes unread stdio to
complete the Node close contract. Destroy cancels the owned Web reader and settles its drain,
including an outstanding read. Caller ref/unref intent is kept separately from pipe demand;
new output demand can reference a dormant waiter without undoing an explicit unref.
These input/lifetime and demand rules and their fake-host and real-guest regressions are original
adapters, not copied Bun/Node stream code.
Ordinary children join the caller's job from `job_of(0)`; lookup failure is a spawn error,
not a fallback to a separate job. Detached children request their own job, which the parent
can reap with `wait_job` or stop with `kill_job`. Worker-thread children are tracked separately
and killed by PID from private, exactly-once finalization after the parent's public exit listeners,
including exceptional delivery and workers created by exit listeners. Listener removal cannot
disable cleanup. Every owned worker is attempted even if another kill fails, with the errors
reported through the existing fatal exit path. Workers created after finalization are killed
synchronously. This matches thread lifetime even though each worker has its own guest process. Ordinary spawned children keep their existing
orphan behavior and no job-wide signal is sent. Before allocating any descriptor or child,
the original `checkCwd` adapter stats the resolved directory and reports missing or
non-directory paths as `ENOENT` or `ENOTDIR` with syscall `spawn`, rather than an asynchronous
child exit. `js/worker_channel.ts` and `js/worker_threads.ts` carry worker
control frames over two ordinary bound pipes. This replaces the Bun-only spawn, child wait, child
pipe and child kill slots without any compatibility path. Bun's `spawn` option names and result
shapes are the behavior being preserved; no Bun source is copied. The original
`web/src/engine-host.js` adapter overrides only the 14 named networking capability flags;
the mandatory `runtime_proc` process and signal capabilities remain owned by the guest,
without an optional-slot probe or process-native substitution.

The original idle adapter in `crates/bunwasm-runtime/src/host.rs` requests
`runtime_proc.poll` with zero subscriptions for timer-only waits, rather than the
networking poll slot. This uses the process ABI's signal/interrupt wake contract
when there are no open network handles. The timer-only branch of the event loop
in `crates/bunwasm-runtime/src/lib.rs` waits at most 25 ms before re-entering the
signal checkpoint. The original `natives.rs` adapter routes `Bun.sleepSync`
through `State::sleep` and `host::sleep_with`, also using zero-subscription process
polls in slices of at most 25 ms. Before each slice, it dequeues handled signals
from the service and parks them in guest state, preventing pending service signals
from turning the sleep into a busy loop. JavaScript handlers wait until the next
guest checkpoint, which dequeues parked signals before service signals; ignoring
or restoring the default disposition also withdraws parked deliveries. Fatal
selection can unwind from the service dequeue while sleep is still in progress.
Off-wasm host unit tests use the unsupported process-ABI stub and fall back to
`std::thread::sleep`. Original unit fixtures cover idle delays, parked-signal
coalescing and withdrawal, bounded sleep waits, and unwind propagation. These
are original guest control-flow adapters with no ABI change, not copied Bun,
libc or host code.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Guest process ABI](#guest-process-abi) | Host feature | Original direct runtime_proc imports, descriptor-bound Bun spawn and worker control pipes, private exactly-once parent-exit worker teardown, process-aware idle waits, native/Node linkers, nonblocking filesystem preparation and lazy browser process integration. |

[Ledger scope and pinned revisions](scope.md).
