# Worker threads

`node:worker_threads` runs separate guests on QuickJS, JSC, and the browser engine.
The native launcher creates a separate Wasmtime instance. The Node host creates a
Node worker running another guest. The browser host starts a Web Worker.
The main guest exports `isMainThread = true`, `threadId = 0`, `parentPort = null`
and `workerData = null`. Workers have their own globals, positive thread IDs,
`isMainThread = false`, cloned `workerData`, and a connected `parentPort`.

## Supported operations

`new Worker` accepts an absolute or relative file path, a file URL, a data URL,
or a code string with `eval: true`. TypeScript files use the normal guest loader.
`argv`, copied `env`, `SHARE_ENV`, `workerData`, `transferList`, `stdin`, `stdout`,
`stderr`, and `resourceLimits` are supported. The supported explicit `execArgv`
flags are `--require`, `-r`, `--require=`, `--no-warnings`, `--expose-gc`, and
`--experimental-strip-types`. Other explicit flags throw
`ERR_WORKER_INVALID_EXEC_ARGV`.

Workers emit `online`, `message`, `messageerror`, `error`, and `exit`.
`terminate()` cancels the child guest and keeps it referenced until completion.
It resolves with the termination code, or `undefined` if it has already exited. `ref()`
and `unref()` control whether the child keeps its parent alive. A worker's
`process.exit()` ends that guest without ending its parent. Output goes to the
parent by default. With `stdout: true` or `stderr: true`, the corresponding Node
readable stream lets the caller consume it. `stdin: true` exposes a writable stream.
A typed signal termination emits its selected exit status, not a synthesized ordinary
uncaught-worker error. The host's final kind, not the numeric status alone, makes
that distinction; a genuine ordinary crash with the same status still reports an error.

`MessageChannel`, `MessagePort`, and `BroadcastChannel` work within and between
guests. The global constructors match the module exports. Ports clone cycles,
arrays, Maps, Sets, dates, regular expressions, errors, boxed values, ArrayBuffers,
and typed-array views. ArrayBuffer transfers detach the sender. MessagePort
transfers move endpoint ownership and preserve queued messages and ordering.
Messages and transfer lists are validated before transfer ownership commits.

Ports queue cloned messages until `start()`, an `onmessage` handler, or a web or
Node `message` listener starts delivery. Synchronous receive removes a queued message
without emitting its event. Node event methods reuse the runtime's EventEmitter.
Closing a port cancels future delivery tasks and drops its pending queue.
A delivery batch already executing finishes before the close event, as in Node.
The close task disconnects the pair and emits `close` on both ends exactly once.
Messages already sent to the open peer stay queued even if it has not started.
Synchronous receives or later delivery drain that queue before the peer closes.
A pending peer close schedules no polling tasks. Explicitly closing the peer
discards its queue.
The peer can still post a synchronously received message before disentangling.
`receiveMessageOnPort` accepts both MessagePort and BroadcastChannel. For a
BroadcastChannel it returns `undefined` without consuming queued messages, matching
native Bun 1.4.2. Node 26.7.0 instead returns the queued broadcast message. Reference
counts keep a listening port or open broadcast channel alive until it is closed or
unreferenced. Broadcast channels communicate across guests through the root broker.

With browser shared objects, a channel whose ends live in different guests gets its
own shared lane (`web/src/shared-objects/lane.ts`): two single-writer rings of 1 MiB,
one per direction, moved with the port when it is transferred. A packet committed
there is readable by the peer's current owner as soon as `postMessage` returns, so a
reply posted before `Atomics.notify` reaches a caller blocked in `Atomics.wait`, as
esbuild's `transformSync` needs. When the peer's ring is full, a packet takes the
broker route instead, and sequence numbers keep delivery in order. That route carries
at most one 8 KiB frame, so a larger packet to a full ring is rejected. A packet larger
than a whole ring throws `DataCloneError` before anything is detached.

`setEnvironmentData` stores values by key identity within a guest. Workers inherit
a cloned snapshot at construction. A value of `undefined` deletes an entry.
`markAsUntransferable` permanently marks an object. Both structured clone and port
messages reject marked objects in transfer lists.

## Host limits

The existing host budget permits four active child guests, including nested
workers and subprocesses. Worker guests share the host filesystem. Browser guests use the shared filesystem service.

The original host adapters reserve child-pipe selectors 4/5 for worker control:
4 carries parent-to-worker input and 5 carries worker-to-parent output. A worker
queries its own endpoints with child handle 0. Selector 3 remains final-signal
metadata for a child handle; it is never a worker pipe. Native completion closes
the worker's input reader and output writer before publishing its result, so
late parent writes fail with EPIPE while buffered worker output drains to EOF.
These channels are separate from stdio selectors 0–2 and their inheritance modes.
See [the host ABI](host-abi.md#process-imports).

Native `resourceLimits` maps the combined old and young heap limit to the guest's
WebAssembly memory budget. Node hosts also pass limits to the physical V8 worker.
Their physical stack retains the minimum required to run the wasm engine.
`stackSizeMb` bounds the guest's configured recursion budget. Browser hosts cannot
enforce V8 heap-generation or code-range limits. `resourceLimits` reports the
requested values; it does not claim engine-specific limits were enforced.

Cross-guest SharedArrayBuffer and WebAssembly.Module cloning are unsupported and
throw `DataCloneError`. SharedArrayBuffer sharing needs a host object table rather
than a byte copy. `SHARE_ENV` propagates ordered updates before message and exit
events. It does not support synchronous polling loops across guests. The control
channel bounds an incoming frame at 64 MiB. VM contexts remain unsupported, so
`moveMessagePortToContext` validates its arguments and then throws.

Bun's upstream module needs its C++ `createNodeWorkerThreadsBinding` and native
web-worker constructor during initialization. These hooks are unavailable through
the builtin loader. This implementation uses original TypeScript adapters and the
existing subprocess hosts. It copies no upstream implementation.

## Verify

```sh
source env.sh
scripts/test.sh --no-build worker-threads worker-execution worker-port-closure worker-review
scripts/test.sh --no-build --engine jsc worker-threads worker-execution worker-port-closure worker-review
scripts/test.sh --no-build --engine browser worker-threads worker-execution worker-port-closure worker-review
scripts/test-web.sh
```

The fixture checks the main-thread exports, environment key identity, cyclic
cloning, synchronous draining, transfer markers, ArrayBuffer detachment, queued
Node events, web handlers, broadcast delivery, references, closing, and the
deadline of an unreferenced timer while a port keeps the guest alive. Its output
matches the adapter's contract. The separate `worker-threads-close` and
`worker-threads-close-queued` fixtures also pass unchanged on Node 26.7.0.
`worker-threads-receive` pins native Bun's BroadcastChannel behavior.
`worker-threads-peer-close` also passes on Node 26.7.0 and covers an unstarted
peer's retained queue, synchronous draining, later delivery, and explicit closure.

The worker-execution fixture checks isolated globals, cyclic data, buffer and port
transfers, queued messages, metadata, environment data, stdio, preload flags,
errors, explicit exit, termination of an infinite loop and a message flood,
nested workers, and references. The same fixture runs through real browser Web
Workers in Chromium and WebKit for all engines. Acyclic browser modules use blob
URLs because WebKit can start a fresh worker outside the module service worker's
control. Import cycles retain named module URLs and require service-worker
control, as before. This also applies to file workers and subprocesses.

The `worker-review` cases also run directly on Node. They check unhandled errors
and throwing lifecycle listeners, two-million-byte messages during explicit exit
and exit listeners, atomic transfer rejection and constructor cleanup, termination
after unref without another reference, drained stdout and stderr above 64 MiB,
and termination after natural exit. Protocol parsing queues lifecycle delivery
as event-loop callbacks. Exit drains the outgoing control pipe before host
teardown. Worker streams have no cumulative subprocess capture limit.


## Global Web Worker

The global `Worker` constructor wraps the same guest execution as
`node:worker_threads.Worker`. It accepts file paths, file URL strings and objects,
data URLs, and object URLs made from Blob or File. TypeScript entry points use
Bun's transpiler. `name`, `argv`, `env`, `preload`, and `ref: false` configure the
worker. `preload` accepts a path or an array of paths. `data` is cloned at
construction and is available through `node:worker_threads.workerData`.
Entries are modules, including when `type: "module"` is specified. `smol` is
accepted as a memory-use hint. It does not change the guest engine's heap policy.

The parent receives EventTarget `open`, `message`, `messageerror`, `error`, and
`close` events. Property handlers work alongside event listeners. `MessageEvent.ports` contains
transferred ports in transfer-list order, including ports absent from the data. `open` precedes
entry execution, so a missing entry still produces `open` before `error`.
Messages sent before natural exit drain before `close`. `terminate()` requests
termination and suppresses later messages. The final `close` event follows host
completion. `ref()` and `unref()` control the parent's lifetime.

Incoming messages stay queued while dependencies and preloads load. Delivery
starts after the entry's synchronous code runs, including before a top-level
`await` settles. After that point, messages with no handler are dropped.
An accepted port batch drains through microtasks before later broadcast tasks,
so installing a handler from a broadcast callback does not revive earlier messages.

Inside a web worker, `self` is the global object. `postMessage`, `onmessage`,
`onmessageerror`, `addEventListener`, `removeEventListener`, `dispatchEvent`,
`close`, and `name` are available. A message handler keeps the child alive.
`Bun.isMainThread` is false in both web and Node workers.

The adapter uses original TypeScript because Bun's implementation requires
JavaScriptCore C++ bindings. The existing four-child host budget and shared
memory limitations apply. Object URL registries are local to a guest. Creating
a worker captures the blob's contents, so immediate revocation does not cancel
that startup. This differs from Bun's deferred blob lookup. Cross-worker object URLs and shared buffers need separate lifetime and sharing
support.

The focused fixture runs with `scripts/test.sh --no-build web-worker`, repeated
with `--engine jsc` and `--engine browser`. The full web gate also runs
`web/tests/browser-web-workers.ts` in
Chromium and WebKit on all engines.

## Measurements

These counts come from the upstream Bun suite at revision `5e0baa66516f3af00b008cdf1521c681317741e8`, run with `scripts/bun-suite.sh` through the measurement scripts below. Each script takes an engine (`quickjs`, `jsc` or `browser`) and a result path.

- `node:worker_threads` execution: of the 120 tracked files in Node's parallel suite that construct a `Worker`, 64 pass on each engine. The browser engine has one known timeout, a 10,000-round-trip test at the 15-second file deadline. The official esbuild synchronous worker check fails 0/3 because shared buffers cannot cross guest boundaries. Reproduce with `scripts/measure-worker-execution.sh <engine> <result.json>`.
- Main-thread import: the first 160 files of `test/js/node/test/parallel` pass 61 (QuickJS), 61 (JSC) and 60 (browser), up from 0 before `worker_threads` existed. Reproduce with `scripts/measure-worker-threads.sh <engine> <result.json>`.
- Global `Worker`: the eleven `web-worker` cause files pass 3/11 on every engine, with 60 (QuickJS), 58 (JSC) and 61 (browser) observed assertions. `worker.test.ts` completes with 31 passes and 11 failures on each engine. Reproduce with `scripts/measure-web-workers.sh <engine> <result.json>`.
- Open gaps: the four-child budget, cross-guest `SharedArrayBuffer`, environment-proxy cloning, unsupported execution flags and VM APIs, loader-error diagnostics, `BroadcastChannel` close and inspection behavior, and shared object-URL lifetime.
