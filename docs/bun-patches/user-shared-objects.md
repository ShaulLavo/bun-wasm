# User shared-object transport

The shared-object service in `web/src/shared-objects/` is an original Bun host
adapter. The graph changes in `worker_codec.ts`, declarations in
`worker_protocol.d.ts`, and pending-attachment scheduling in `worker_threads.ts`
are original extensions of the existing worker adapter. These changes copy no
upstream implementation. The public contract reference is Bun's `src/js/node/worker_threads.ts`
at revision `9510e74152073d850a18758ca41114d8f214ffa6`.

The optional service carries actual native SharedArrayBuffer backing stores
outside the JSON graph. A process-scoped native port registers backing stores
with a runtime-owned broker. Graph preparation reserves identifiers locally.
Publication occurs only after serialization and transfer validation. Failed
publication or delivery aborts the reserved references without detaching the
transfer list. Receiver ports preserve message sequence while backing arrives,
and continue scheduling preceding ready messages. Closing a receiver port
cancels its pending attachment subscription.

The native host interface is Bun-owned. It describes native worker-global
`postMessage`, not Waffle's typed `RuntimeWorkerHost.postMessage` union. No Waffle
source or pin changes are needed. The accepted provider proof uses a separate
Waffle source identity from the consumer's current pin.

An internal installation in `web/src/shared-objects/runtime.ts` keys the broker
by the Waffle Runtime identity. The launcher acquires a process route only when
that installation already exists. Executor setup exports its native port before
guest entry. Revocation, cleanup, failed setup, engine construction failure and
engine exit release the service or its broker lease. Engine attachment waits hold
its pending-work count and wake its event loop exactly once when settled.

There is no default runtime installation. Bootstrap forwards an explicitly supplied
private service into the guest internal object. Each codec captures its own opt-in.
Only source MessagePort and Worker startup codecs receive the service. Direct codecs,
v8 serialization, BroadcastChannel graphs, clones, and worker error graphs remain
strict even when the private service is installed. Public worker serialization
still rejects SAB without that installation. Nested graph-route liveness remains
separate integration work. Releasing routes and broker references cannot revoke native
SAB aliases already delivered to guest code.

## Classification

| Source | Class | Change |
| --- | --- | --- |
| Shared-object protocol, service, broker, codec, and port scheduling | Host feature | Original guarded native SAB, WebAssembly.Module and shared WebAssembly.Memory transport with staged publication, attachment ordering, and process-owned reference cleanup. |

[Ledger scope and pinned revisions](scope.md).

## Retained upstream test fragment

`scripts/fixtures/shared-objects/esbuild-run-call-sync.txt` is an unchanged copy
of `runCallSync` from `esbuild-wasm@0.25.12`, `lib/main.js`, starting at line
1939. It is copied test source, not original adapter code, and is classified
as a Port regression fixture. The native-worker test injects its surrounding
bindings and evaluates the exact fragment without changing its wait or reply
logic.

The captured archive SHA-256 is
`e0712c0e7a9bcfb53c648f63222b07d6ef052897da093498441b8ac5fcfc5342`.
The captured `lib/main.js` SHA-256 is
`18b154677d0965c21748afe9b5f56fb11a664a9a6e21dd5fd5ecf9791384e700`.
The test uses the project-pinned Waffle pipe source without compiling it.
The source-runtime fixture adds only child registration and incoming-packet
injection to the module exports. Codec, port acceptance and byte framing run
from production source without replacement implementations.

## Guarded limits

The service owns references for its process lifetime. Closing a source
MessagePort cancels that port's missing-attachment subscription, not backing
already shared with another source port in the same process. Runtime shutdown
must call the service close method and the broker lease close method. Abrupt
native-port disappearance alone is not a process-lifetime signal here.
Concurrent preparations of the same new backing reject explicitly until the
first publication commits or aborts. This avoids assigning conflicting object
identities to overlapping transactions. Node Buffer backed by SAB remains
unsupported. Engine value-native binding is installed only for an explicitly
supplied private service. Worker startup waits for missing workerData, environmentData, and queued
transferred-port backing before graph decode, port activation, preloads, or entry.
Ordinary already-ready startup remains synchronous. A single readiness promise
gates engine entry, and failure or exit cancels hydration without reviving entry.
Nested byte-graph routing remains unimplemented. The internal installation owner must call `close()` when it
releases the Runtime; process route revocation is not a Runtime disposal hook.

Commit preflights transfer validity before publishing, then delivers the byte graph
before detaching ArrayBuffers and moving ports. Tests cover rejected serialization,
failed native publication and thrown byte-graph delivery with no detachment. This
is not a general distributed transaction for arbitrary native detach or route-move
failures after a receiver has already accepted the graph.

The startup regression fixture evaluates the actual bootstrap, worker factories,
and EngineHost entry gate with native MessageChannels. It stubs unrelated module
services and the entry body. This is source-host evidence, not a built guest or
an application result.

## Native WebAssembly objects

Browser-engine workers publish native `WebAssembly.Module` and shared
`WebAssembly.Memory` through the same transaction and broker as SAB. These are
original host extensions, with no copied implementation. Modules clone for each
decoded graph. Repeated references inside a graph retain object identity, and
attached shared memories retain their backing across messages and growth.
Unshared memories, Wasm objects in transfer lists, and codecs without the native
Wasm capability reject with `DataCloneError`. Native references use a zero
byte-length marker because memory growth does not change their identity.

`tests/fixtures/worker-wasm/` is an original regression fixture. It pins
`@emnapi/core` and `@emnapi/runtime` at `2.0.0-alpha.5`, the versions declared by
`@rolldown/binding-wasm32-wasi@1.2.15`, and calls the unmodified `MessageHandler`
load/start path. The addon imports one 64 KiB shared memory and exports atomic
wait/notify and `wasi_thread_start`. `atomic-module.ts` contains the bytes assembled
from `atomic.wat` with `wasm-tools parse`; it copies no upstream source.

The browser gate runs two real Bun browser-engine workers through the production
codec, launcher and broker. It checks shared writes in both directions, native
Wasm wait/notify, emnapi load/start, and release of process-owned references after
worker termination. The source tests cover failed publication and delivery,
unread-message discard, unavailable capabilities and nested decode preflight.
The fixture does not load Rolldown or allocate its 1 GiB memory.
