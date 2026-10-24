### Node event emitter

`crates/bunwasm-runtime/src/js/events.js`. Class **Port**. Comparison sources are Node `lib/events.js` at the Node comparison revision and Bun `src/js/node/events.ts` at the Bun pin. The direct Node import revision is not recorded.

Retain listener storage conventions, once-wrapper state, listener removal, and remove-all behavior. Replace primordials, internal validators, and native async-resource or EventTarget integration with local validation and runtime scheduling. The module also supplies local promise and async-iterator helpers. These changes provide Node-style listener semantics on the guest event loop without native async hooks.

The listener-publication hook is a separate **Host feature**, an **original adapter**, not copied
from Node or Bun. It runs immediately after listener storage mutates and before user removal
observers, publishing this host's signal disposition synchronously. It covers prototype calls,
once wrappers, removal, remove-all and reentrant observers without replacing the retained
EventEmitter bookkeeping or adding native async hooks. Its process/stdout consumers are original
host adapters described under [Browser process service](browser-process-service.md#browser-process-service).

`crates/bunwasm-runtime/src/js/event_emitter_async_resource.ts`. Class **Port**.
Adapted from `src/js/node/events.ts`, `EventEmitterAsyncResource` and its referencing
resource, at Bun pin `9510e74152073d850a18758ca41114d8f214ffa6`. The local
factory uses the guest's existing AsyncResource bridge instead of Bun's native
async hooks and internal primordials. A lazy enumerable export avoids a module
initialization cycle. Listener dispatch enters the resource's captured context;
resource identity, emitter reference and destruction forward to that bridge.
This does not add native async-hook lifecycle notifications or change async-ID
allocation in the existing bridge.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/events.js`](#node-event-emitter) | Port | Adapt Node listener bookkeeping without native async hooks. |
| [`event_emitter_async_resource.ts`](#node-event-emitter) | Port | Adapt Bun's async emitter to the guest AsyncResource context bridge. |
| [`crates/bunwasm-runtime/src/js/events.js`, listener publication](#node-event-emitter) | Host feature | Original mutation hook publishes signal dispositions before user listener-removal callbacks. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
