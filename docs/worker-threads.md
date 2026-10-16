# Worker threads

`node:worker_threads` loads on QuickJS, JSC, and the browser engine. Every guest is
currently a main thread. It exports `isMainThread = true`, `threadId = 0`,
`parentPort = null`, `workerData = null`, an empty `resourceLimits`, and `SHARE_ENV`.
Node's shared test helper can import the module without starting a worker.

The module also exports `MessageChannel`, `MessagePort`, `BroadcastChannel`,
`receiveMessageOnPort`, environment-data accessors, and transfer markers. The global
messaging constructors are the same constructors exported by the module.

Ports queue cloned messages until `start()`, an `onmessage` handler, or a web or
Node `message` listener starts delivery. Synchronous receive removes a queued message
without emitting its event. Node event methods reuse the runtime's EventEmitter.
Closing either end disconnects the pair and emits `close` on both ends. Reference
counts keep a listening port or open broadcast channel alive until it is closed or
unreferenced. Broadcast channels communicate among instances in one guest.

`setEnvironmentData` stores values by key identity within the guest. A value of
`undefined` deletes the entry. `getEnvironmentData` returns the stored value.
`markAsUntransferable` permanently marks an object, and both structured clone and
port messages reject marked entries in an ArrayBuffer transfer list. Unmarked
ArrayBuffers use the runtime's existing clone-and-detach implementation.

`Worker` still throws `ERR_NOT_SUPPORTED_IN_WASM` when constructed. Running guest
workers, inherited environment data, messaging between guests, transferable
MessagePorts, worker stdio, and worker termination belong to the next change.
`moveMessagePortToContext` validates the port and reports closed ports, then throws
because the runtime has no VM contexts.

Bun's upstream module requires its C++ `createNodeWorkerThreadsBinding` and native
web-worker constructor at initialization. This implementation is an original
TypeScript adapter over the current guest event loop, EventTarget, EventEmitter,
and structured clone. It retains no upstream implementation.

Run the focused fixture on each rebuilt engine:

```sh
source env.sh
scripts/test.sh --no-build worker-threads
scripts/test.sh --no-build --engine jsc worker-threads
scripts/test.sh --no-build --engine browser worker-threads
```

The fixture checks the main-thread exports, environment key identity, cyclic
cloning, synchronous draining, transfer markers, ArrayBuffer detachment, queued
Node events, web handlers, broadcast delivery, references, closing, and the
deadline of an unreferenced timer while a port keeps the guest alive. Its output
also matches Node 26.7.0.

## Node parallel-file measurement

The unmodified first 160 tracked `.js` files under
`test/js/node/test/parallel`, sorted by path, were measured before and after this
change. The upstream revision, runner, dependencies, selection, and per-engine
deadlines are identical within each comparison. The original runtime baseline is
`f5d18cf`; the combined branch also includes the WebSocket builtin from
`40f7956`, which the selected files do not import. These census records predate
the closed-pipe merge `4da6a6b`; the required gates are repeated after rebasing
onto that host change.

| Engine | Fully passing files before | Fully passing files after | Observed test passes before/after | Timeouts before/after |
| --- | ---: | ---: | ---: | ---: |
| QuickJS | 0/160 | 61/160 | 0/0 | 0/1 |
| JSC | 0/160 | 61/160 | 0/0 | 0/1 |
| Browser | 0/160 | 60/160 | 0/0 | 0/0 |

These are Node assertion scripts. The suite runner counts a clean script exit as
a fully passing file and does not count its individual assertions. There are no
newly failing files that previously passed. Before the change, the common helper
stopped while importing `worker_threads`; after it, tests reach their own code.

The browser censuses pass 59 or 60 files because
`test-child-process-can-write-to-stdout.js` intermittently sees empty stdout in
its exit listener. The timer-corrected artifact before rebasing onto the WebSocket
builtin passed 59 files; two of three isolated repetitions on that wasm failed
the stdout assertion, and one passed. The combined artifact after rebasing onto
`40f7956` passes 60 files. The table uses that combined artifact's full census.
Earlier measurements and all repetitions are retained.

The newly reached timeout is `test-async-local-storage-http-agent.js`, which needs
HTTP request streaming. The browser engine instead fails an earlier async-context
assertion in that file. ALS default values, `node:test`, and other remaining gaps
are recorded in [the compatibility follow-ups](../plans/compatibility-followups.md#node-parallel-tests-after-main-thread-worker-imports).

QuickJS and browser runs use four jobs with a five-second file deadline. JSC runs
use two jobs with a fifteen-second deadline. Native launcher modules are compiled
once before the census. The first cold JSC attempt was interrupted because its
five-second deadline expired before guest code ran; it is excluded from the table.
The baseline builds use frozen copies of the original runtime factories through
`BUNWASM_JS_OVERRIDE_DIR`. The added worker module is unreachable from those
original factories.

The selection and warm-up are reproducible with
`scripts/measure-worker-threads.sh`. Run it through the heavy-job wrapper after
building the chosen engine and the native launcher in a private Cargo target:

```sh
source env.sh
export CARGO_TARGET_DIR=/work/tmp/bun-wasm-worker-threads-target
bash /work/tmp/wave-heavy/run.sh --class suite worker-threads-census -- \
  env PATH="$PATH" scripts/measure-worker-threads.sh quickjs \
  /work/tmp/bun-wasm-worker-threads-new-quickjs.json
```

Use `jsc` or `browser` for the other engines. Raw before/after JSON, JSONL, build
logs, gate logs, selection, and artifact hashes are retained in
`/work/reports/bun-wasm-worker-threads/` until coordinator acceptance.
