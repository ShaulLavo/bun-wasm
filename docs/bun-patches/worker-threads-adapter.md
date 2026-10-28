## Worker threads adapter

The public `MessagePort` and `MessageChannel` constructor proxies are original
host adapters. They attach Node's constructor error codes without exposing the
private construction token or changing the internal class and static-private
brands. Instances retain the public constructor identity and subclass behavior.
Compared with Bun `src/js/node/worker_threads.ts` and Node's
`test/parallel/test-worker-message-port-constructor.js` at Bun pin
`9510e74152073d850a18758ca41114d8f214ffa6`. This is not copied upstream code.

`crates/bunwasm-runtime/src/js/worker_threads.ts` implements worker metadata,
guest lifecycle and routed port ownership. `worker_codec.ts` serializes cyclic
object graphs and transferable buffers and ports. `worker_channel.ts` frames
control messages over two private host pipes. `worker_stdio.ts` adapts the existing
subprocess streams to Node streams. These are original TypeScript implementations.

A file worker's guest is started as `<execPath> -- <file>`. `--` marks a file operand
both for `bun` and for a process started as `node`, whose operands are always files
(`crates/bunwasm-cli/src/main.rs`). The former `run <file>` form made such a worker
load a module named `run`. A spawned `node` child calling esbuild-wasm's `transformSync`
then waited forever for its file worker. `tests/fixtures/worker-node-executable` covers it.

The original Rust adapters in `crates/bunwasm-host/src/process/` give each worker
its own Wasmtime instance and control pipes. The original Node host adapter in
`web/scripts/node-host.ts` starts another physical Node worker. The browser host
adapters in `web/src/{worker,bun-executor,bun-launcher}.ts` use Web Workers and
Waffle's process-owned pipe buffers. Nested guests share a root port broker and the existing child
budget. Bootstrap, process, spawn and structured-clone hooks connect those
adapters to the guest event loop. No upstream source was copied.

The original loader in `web/src/content-modules.ts` creates blob module URLs for
acyclic browser imports. Only a cycle reserves a named URL before its source is
available. Eval workers need no HTTP module request, so an uncontrolled WebKit
worker cannot bypass the module service worker and get a 404. Named URLs retain
native import cycles. Failed source builds retain unfinished cycle reservations;
recorded dependency edges repair them when retrying the root or a cached child,
without discarding successful reentrant imports. The Node host keeps its existing
named module loader. `web/tests/browser-worker-modules.ts` repeats atomic transfer rollback twenty
times per browser and also starts children outside the module scope.

The inspected upstream implementation is `src/js/node/worker_threads.ts` at Bun
revision `9510e74152073d850a18758ca41114d8f214ffa6`. Its module initialization needs
`Worker.cpp` native bindings and the native web-worker constructor, so it cannot
run through the builtin loader with the hooks currently available.
[Worker threads](../worker-threads.md) records supported operations and host limits.

`web/scripts/node-process.ts` is an original adapter that installs Waffle's `ProcessABI`
under the `runtime_proc` namespace for browser-native, embedded QuickJS and JSC guests.
Its descriptor table bridges pipe/terminal fd calls alongside Node WASI's filesystem fds;
`node-spawn.ts` owns the shared supervisor and worker/pipe brokers. The TypeScript
`node-host.ts` runs the root guest in a worker as well as its children, keeping that
supervisor responsive while guest code makes synchronous process calls. The existing
`node-host.mjs` is only a TypeScript-entry shim. CLI fetch uses the networking import
dispatcher; signal handling uses `runtime_proc.signal`, sharing the process wake signal. The slot installer
loads Waffle's exported memory helper, whose source and generated Node modules are
fingerprinted with every local host module by the upstream-suite resume gate.

The original atomic-transfer native checks the complete buffer list before
detachment. QuickJS uses its public detach operation plus the inspection helper
above. The JSC adapter adds original `JSArrayBuffer` inspection and detach hooks
in `crates/bunwasm-jsc/cpp/helpers.cpp`, against the same pinned WebKit headers as
the existing helpers. Its original unpinned byte accessor replaces the C API's
`JSObjectGet{TypedArray,ArrayBuffer}BytesPtr`, which pin and lock a buffer for
good, so buffers native code reads or fills stay detachable. The browser adapter in `web/src/buffer-transfer.ts` captures the host's structured
clone operation and tracks native WebAssembly memory buffers through their
buffer getter. It rejects the whole list before Chromium can partially detach
it. WebKit and Node already preserve earlier buffers in this case. Copied
WebAssembly memory buffers are tracked by the original runtime adapter and
rejected as transfers.
No Bun vendor patch is needed for these adapters.

The peer-close fixes are retained in the routed adapter. A pending peer-close
sequence preserves an unstarted peer's queue until it drains, without polling.
Local closure suppresses future delivery while selected messages finish, with
promise continuations between messages. BroadcastChannel receive returns
`undefined` without consuming its messages, matching native Bun 1.4.2.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Worker threads adapters](#worker-threads-adapter) | Host feature | Original TypeScript worker, clone, port-routing, coded constructors, browser module loading and stream adapters over separate host guest instances, with dynamically bound control pipes and typed wait outcomes. |

[Ledger scope and pinned revisions](scope.md).
