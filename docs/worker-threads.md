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
`terminate()` cancels the child guest and resolves with its exit code. `ref()`
and `unref()` control whether the child keeps its parent alive. A worker's
`process.exit()` ends that guest without ending its parent. Output goes to the
parent by default. With `stdout: true` or `stderr: true`, the corresponding Node
readable stream lets the caller consume it. `stdin: true` exposes a writable stream.

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

`setEnvironmentData` stores values by key identity within a guest. Workers inherit
a cloned snapshot at construction. A value of `undefined` deletes an entry.
`markAsUntransferable` permanently marks an object. Both structured clone and port
messages reject marked objects in transfer lists.

## Host limits

The existing host budget permits four active child guests, including nested
workers and subprocesses. Worker guests share the host filesystem. Browser guests use the shared filesystem service.

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
scripts/test.sh --no-build worker-threads worker-execution worker-port-closure
scripts/test.sh --no-build --engine jsc worker-threads worker-execution worker-port-closure
scripts/test.sh --no-build --engine browser worker-threads worker-execution worker-port-closure
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
Workers in Chromium and WebKit for all engines.


## Guest worker measurement

Measured 2026-10-17. The same 120 tracked `.js` files under Node's parallel
suite contain a `new Worker` or namespaced Worker construction. The upstream
suite revision is `cd95fa7a13b3f13be73e512b38ec111c1c228084`. The baseline is
Step 1 at `8596b11a`; the tested worker implementation is `9f780ca4`, rebased
onto the reviewed Step 1 revision `dba93905` and main through #34. This comparison
also includes those intervening port-close and shared-filesystem fixes.

| Engine | Fully passing before | Fully passing after | Observed passes before/after | Timeouts before/after |
| --- | ---: | ---: | ---: | ---: |
| QuickJS | 21/120 | 67/120 | 0/0 | 0/0 |
| JSC | 21/120 | 67/120 | 0/0 | 0/0 |
| Browser | 21/120 | 67/120 | 0/0 | 0/1 |

Forty-six additional files pass on each engine. No previously passing file fails.
These are Node assertion scripts. A clean script exit counts as fully passing,
including files which skip before constructing a worker. They report no individual
assertion counts, so observed test passes remain zero. The browser timeout is
`test-worker-message-port-message-before-close.js`, which runs 10,000 port round
trips within the common fifteen-second file bound.

`scripts/measure-worker-execution.sh` reproduces the exact selection with two jobs
and a fifteen-second deadline on every engine. It warms the native module first.
Build the launcher and engines in private targets, then run through the heavy wrapper:

```sh
source env.sh
export CARGO_TARGET_DIR=/work/tmp/bun-wasm-worker-check-target
bash /work/tmp/wave-heavy/run.sh --class suite worker-execution-census -- \
  env PATH="$PATH" scripts/measure-worker-execution.sh quickjs \
  /work/tmp/bun-wasm-worker-quickjs.json
```

Use `jsc` or `browser` for the other engines. The original baseline snapshot,
selection, raw results, artifact hashes and exact gate scripts are retained in
`/work/reports/bun-wasm-worker-execution/` until coordinator acceptance.

The final batched gate passes 158 fixtures on each engine, 243 web unit tests,
all six real-browser Worker runs, and all six HMR runs. The full web gate then
fails in the independently confirmed main memory-growth regression at
`web/tests/browser-memory.mjs:65`, where Chromium's guest command times out with
`null !== 0`. That failure also appears in the
[Step 1 independent review](https://github.com/ShaulLavo/bun-wasm/pull/31#issuecomment-6225280460).
It remains an external gate blocker; this is not an all-green result.

### Worker-dependent app checks

Vite React and Vitest, including an explicit `--pool=threads` command, have the
same results before and after. All six installs pass; none of their twelve app
commands pass. They stop while Vite calls `import.meta.require("ws")`, before
reaching their worker backend. The offline mirror has 1,295 entries, with no
missing or corrupt records during either comparison.

The unchanged `esbuild-wasm@0.25.12` synchronous fixture also remains at zero of
three fully passing engine runs. QuickJS and the browser engine reach
`DataCloneError` while cloning its SharedArrayBuffer. JSC stops because
SharedArrayBuffer is unavailable. This feature does not supply shared memory
between guests or force esbuild onto a different backend.

```sh
source env.sh
scripts/app-matrix.sh --apps=vitest,vite-react --hosts=native \
  --engines=quickjs,jsc,browser --timeout=45 --cache=/path/to/offline-mirror \
  --launcher="$CARGO_TARGET_DIR/release/bun-wasm" --output=/path/to/results
MATRIX_CACHE=/path/to/offline-mirror \
  BUN_WASM_LAUNCHER="$CARGO_TARGET_DIR/release/bun-wasm" \
  ESBUILD_CHECKS=sync.cjs bun tests/esbuild/run.mjs
```

## Main-thread import measurement

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
