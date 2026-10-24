### Node event emitter

`crates/bunwasm-runtime/src/js/events.ts`. Class **Port**. Comparison sources are Node `lib/events.ts` at the Node comparison revision and Bun `src/js/node/events.ts` at the Bun pin. The Node comparison revision is `caa20e28dc1f21a97f7b2a7134973fd6435b65f0`; the Bun pin is `9510e74152073d850a18758ca41114d8f214ffa6`. The direct Node import revision is not recorded.

Retain listener storage conventions, once-wrapper state, listener removal, and remove-all behavior. Replace primordials, internal validators, and native async-resource or EventTarget integration with local validation and runtime scheduling. The module also supplies local promise and async-iterator helpers. These changes provide Node-style listener semantics on the guest event loop without native async hooks.

The TypeScript conversion separates initialized instance storage from optional prototype
storage and groups event-source registration with its removal methods. `events-types.d.ts`
is an original type adapter, not upstream source. This is not an assertion-free conversion.
The audited erased constructor bridge remains at the factory return. TypeScript cannot give
the privately declared ordinary function a construct signature in this lexical scope, or infer
its `Object.defineProperty` statics. The discovered constructor fixture and
`scripts/runtime-events.test.ts` check call, new, subclass, prototype storage, descriptors,
static accessors and the lazy async-resource export.

The parent separately authorizes exactly six erased private-invariant views. The syntax fence
checks these expressions and their owning functions, plus the constructor expression:

| Owner | Allowed expression | Count |
| --- | --- | ---: |
| `onceWrapper` | `this.wrapFn as Listener` | 1 |
| `settle` | `waiters.shift() as BunWasm.Events.Waiter` | 1 |
| `onError` | `waiters.shift() as BunWasm.Events.Waiter` | 1 |
| `settleClose` | `waiters.shift() as BunWasm.Events.Waiter` | 1 |
| `settleClose` | `queue.shift() as Item` | 1 |
| `next` | `queue.shift() as Item` | 1 |
| Factory return | `EventEmitter as typeof EventEmitter & BunWasm.Events.Constructor` | 1 |

The once state has the original own-property order, including `wrapFn` initialized to undefined.
Its value type stays `Listener | undefined`. The original after-bind assignment precedes listener
publication; the original wrapper reads the field when removing itself. The five direct shifts
retain their original nonempty guards. The close-result queue is populated immediately before
consumption. These views assume that private initialization and standard typed-library intrinsic
contracts hold. They do not validate or replace mutable methods, guarantee arbitrary fabricated
hook results, or authorize assertions elsewhere. Forwarding bind and shift hooks retain the
original raw undefined behavior, error identity, property-access ordering and cleanup effects.
No checked-shift helper, failed-path branch, global TypeError lookup or closed-over wrapper remains.

The conversion still includes these executable changes, so the whole runtime AST is not identical:

- Bind the prototype alias before its initial count assignment.
- Assign the listener-array alias only in the branch that proves its shape.
- Build error-monitor arguments with a typed prefix array and the original concat operation.
  The apply invocation contract accepts the resulting argument array without a cast.
- Capture remove-all arguments as an arity-discriminated rest tuple. Restore the function's
  existing length descriptor to 1. Omitted and explicit undefined arguments retain distinct behavior.
- Annotate local Symbol aliases before reading the optional disposal symbol. Both the public
  and implementation return types model a sparse symbol record, not a callable at every key.

The R3 correction restores the complete original executable AST of `onceWrapper`, `onceWrap`
and `EventEmitter.on` against immutable approved source `ac43127c85addabed7e0c2a4883247ae074e858c`.
That comparison covers the original finish-path splice and iteration and every failure path in
those regions. The full AST regression check pins the remaining audited changes and separately
verifies exactly 59 unchanged top-level statements, including strictness and the lazy export.
It does not claim blanket AST or emitted-byte identity.

The private-intrinsics fixture and actual-factory controls cover absent results at each shift
position, a global TypeError getter sentinel, close waiter settlement and every listener cleanup,
and both once methods under forwarding bind. They pin own keys, the wrapFn setter/getter,
reentrant order and sentinel identity. Native Bun does not expose these private shift/bind hooks;
its separate observations stay attributed to native behavior rather than called guest equivalence.
The earlier intrinsic controls retain throwing iterator/species and concat/shift coverage,
including original finish-path exceptions. Native and absent disposal-symbol controls still test
the one actual key and reject missing keys. Listener identity, ordering, receivers, publication
rollback and native async-context contracts retain native and three-engine coverage.

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


The shared inspector declarations are original erased host contracts. All three `require("inspect")` overloads return the same `ConsoleInspector`, which retains `parseStack`, `formatArgs` and `bunInspect` and adds `nodeInspect`. The process declaration retains `cwd`, `stdout`, `stderr` and its `var` declaration, adding only optional `emitWarning`. No inspector or process implementation changes. Six declaration-order compile cases cover these contracts.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/events.ts`](#node-event-emitter) | Port | Adapt Node listener bookkeeping without native async hooks; audit the erased constructor bridge and six private-invariant views. |
| [`events-types.d.ts`](#node-event-emitter) | Host feature | Original erased contracts for the existing emitter and its internal dependencies. |
| `console_types.d.ts` and `runtime.d.ts`, events integration | Host feature | Original erased shared inspector and optional process warning contracts; retain existing console, stack and process members. |
| [`event_emitter_async_resource.ts`](#node-event-emitter) | Port | Adapt Bun's async emitter to the guest AsyncResource context bridge. |
| [`crates/bunwasm-runtime/src/js/events.ts`, listener publication](#node-event-emitter) | Host feature | Original mutation hook publishes signal dispositions before user listener-removal callbacks. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
