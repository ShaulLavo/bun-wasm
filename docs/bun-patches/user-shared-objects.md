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

There is no default runtime installation or injection into the guest internal
codec. Without that separate injection, public worker serialization still rejects SAB.
Startup workerData hydration and nested graph-route liveness remain separate
integration work. Releasing routes and broker references cannot revoke native
SAB aliases already delivered to guest code.

## Classification

| Source | Class | Change |
| --- | --- | --- |
| Shared-object protocol, service, broker, codec, and port scheduling | Host feature | Original guarded native shared backing transport with staged publication, attachment ordering, and process-owned reference cleanup. |

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
supplied private service. Synchronous startup hydration and nested byte-graph routing remain
unimplemented. The internal installation owner must call `close()` when it
releases the Runtime; process route revocation is not a Runtime disposal hook.

Commit preflights transfer validity before publishing, then delivers the byte graph
before detaching ArrayBuffers and moving ports. Tests cover rejected serialization,
failed native publication and thrown byte-graph delivery with no detachment. This
is not a general distributed transaction for arbitrary native detach or route-move
failures after a receiver has already accepted the graph.
