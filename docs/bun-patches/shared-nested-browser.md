# Shared nested Wasm, QuickJS and Browser host

Classification: Original host adapters. `web/src/nested/host.ts`, `wire.ts`, `publication.ts`,
`module-info.ts`, `function-type.ts` and `binary.ts` are the Browser counterpart of the native service described in
[Shared nested Wasm, QuickJS and native host](shared-nested-native.md). No interpreter,
compiler algorithm or upstream runtime implementation is copied into these files. The wire
contract and regionizer are unchanged. One guest change belongs to this work: `spawn.ts` gains a
private `spawnWorker`, used only by `worker_threads.ts`, in place of a public `_worker` option.

A memory group member's worker loads the host on demand and supplies the shared-group-only
`runtime_nested.request` import. Regionized modules compile and run on the page's own
WebAssembly engine, in that worker, importing the group memory. This is the embedded engine
path. Browser engine guests keep their native WebAssembly route and never load this host.

The host uses only public surfaces of the pinned Waffle package: `createRuntime({ memoryGroups })`,
root adoption with `"group"`, `admitRootMemoryGroup`, `launchWorker({ memoryGroup })`, and the
worker executor's `namespaces` and `beforeBindings` hooks. A group core imports only the
`runtime_shm` functions it uses, so the host passes a small declaration module to the public
`wasi.imports` to resolve `shm_create`, `shm_detach`, `shm_publish`, `shm_publication_open`,
`shm_withdraw`, `futex_wait32`, `futex_wait64` and `futex_wake` from Waffle's documented ABI.

Requests and replies follow the frozen serde enums in `wasm/nested_wire.rs`. I64 and F64
payloads keep their decimal text, because JSON numbers would round them. The JS API does not
reflect function types, so `module-info.ts` reads them from the regionized bytes.

Each nested memory is one `shm_create` region, charged in full by the group owner, plus a
16-byte page cell. The region is a reservation chosen from what the group has when the memory is
created, by the native host's rule: the declared maximum when it fits, otherwise the initial bytes
plus optional growth room, and a refusal only when the initial bytes do not fit. The declared
maximum stays the limit that imports are matched against and that a publication carries. The
reservation is the owner's own region length, so a receiver reads it from the owner and no wire
field is added. Growth stops at whichever of the two is smaller. A zero-page memory still owns
one charged identity page. Initial sizes above 32,767 pages are refused, because a region length
is a signed 32-bit size.

Waffle's public `shm_create` takes an exact length and changes nothing when it refuses. The host
therefore asks for sizes largest first: the declared maximum (capped at 32,767 pages), then the
initial pages plus 1,024, 512 and so on down to 1 page of room, then the initial pages alone.
Each request is one atomic owner step, so the choice cannot race another member and needs no view
of the owner's free space. Only a lack of room moves on to a smaller size. A full region table
or any other refusal ends the attempt. If the reservation fits and its page cell does not, the
reservation is returned and the next smaller size is tried, so growth room never takes the page
the cell needs.

Handles carry a slot and generation, as on the native host. Waffle zeroes the whole reservation
when it is created, and growth is a compare-and-swap on the cell, so it never moves storage or
holds a lock a stopped member could leave behind. A failed defined memory detaches both regions. Waffle's owner reclaims holds at its supported member-stop boundary. This does
not prove that the browser agent has physically ended.

The runtime has one authoritative `require("spawn")` declaration for ordinary
spawn, private Worker spawn and executable lookup. Shell and Worker consumers
therefore see the same API regardless of declaration load order. Worker fixture
providers implement `spawnWorker` and carry metadata in its third argument, not
in a public options field.

Workers of a group core join their parent's group, chosen only by the typed `request.worker` field
that `spawnWorker` sets. An environment marker or a public `_worker` option starts a new group.
`PublishMemory` and `PublishModule` make one atomic owner publication each, and the receiver opens
it in one owner step that takes every hold and returns the owner's extents. Kind, relationship,
extents and metadata live in the owner; guest memory holds only the page cell and the module bytes,
so `publication.ts` checks what it reads there before building a view. A module travels as its
original description (UTF-8 JSON) followed by regionized code, and each receiver compiles its own
copy through the same path as `Compile`. A publication survives its sender's stop and ends when
withdrawn or when the group ends. Only the publishing incarnation can withdraw it. Publication
tokens are full u32 values and leave the owner only through an output pointer.

Nested waits and notifies, and QuickJS `Atomics`, use the same `runtime_shm` futex calls on the
same group address. A blocked member is cancelled by Waffle's hard stop. An exit or trap out of
a reentered core entry ends the member. A trap becomes status 134 with a bounded diagnostic at
the outermost request, because a stack overflow leaves no room deeper down. A trap confined to
nested Wasm stays a catchable `RuntimeError`, and a pending JS exception keeps its exact
engine-side value.

## Exported tables

The host answers `TableExport`, `TableLength`, `TableGet`, `TableSet` and `TableGrow` and the
`Null` reply, as the native host does under [its record](shared-nested-native.md). No request,
reply, import or owner entry is added. A table is the page engine's own `WebAssembly.Table`, so
the instance's `call_indirect` and the guest's `WebAssembly.Table` are one table. It lives in the
member's worker and takes no group region, hold or charge.

- Identity. One table object is one handle, whichever export name or request reached it. A
  function has one id whether an export or a table entry named it, so `table.get(i)` is the
  function its export returns. Table and function handles are session-owned, and each kind is
  bounded at 4,096.
- Element type. `module-info.ts` reads each exported table's element type from the module bytes,
  because the JS API does not reflect it. Only a `funcref` table gets a handle.
- Entry types. A table can hold a function no export names: an unexported one, or an imported
  callback. The JS API does not reflect a function's type, and the core needs it to call the
  function. `function-type.ts` asks the engine: it instantiates a module that is one function
  import of a candidate type, and a function of another type is a `LinkError`. Nothing is called,
  and the answer is exact. Candidates are the signatures of the table's own module, since nested
  tables are never imported and a function set from outside already has an id. The entry's name,
  its index where it was defined, only says which signature to try first. One importer module is
  compiled per signature and kept for the session.
- Errors. An index at or past the length, and a refused grow, are a `RangeError` with the native
  message. A null entry is `Null`. `TableSet` and `TableGrow` take a function id of this member or
  null. An entry whose type has a reference parameter or result is refused, as an export is.
- Limits. Growth is bounded by the table's declared maximum and the engine's own table limit.
  The native Store sets no element limit either.

Differences from the native host:

- There is no Wasmtime Store, so the 40-instance ceiling and the admission closure that guards
  retained Store wrappers do not apply. Failed starts retain nothing here. The published
  instance limit is 4,096.
- Optional growth room is the largest of 1,024, 512, ... 1 pages that fits. The native host takes
  half of the contiguous room left after the initial bytes, capped at 1,024 pages. The two agree
  when at least 2,048 pages are left. With less, the Browser host can take up to all of what is
  left, where native leaves at least half for later members. Matching native exactly needs a
  reservation entry in Waffle's group owner, which this host does not add.
- A refused reservation changes nothing. An attempt that is rolled back because its page cell had
  no room leaves its pages grown, charged and on the owner's free list, as any detached region does.
- A Memory's reservation is zeroed by Waffle when it is created, growth room included.
- The JS API reads one value per import module and name. Two imports with the same name and
  different function types are refused with a `LinkError`.
- f32 and f64 values cross JS numbers at this boundary, so NaN payload bits are not guaranteed.
- Nested modules that export a global are refused at compile and at attachment, before any start
  code runs, and `GlobalGet` and `GlobalSet` are refused. Exported tables are supported, above.
- An imported callback read back from a table is the engine's wrapper for that import. V8 keeps
  one wrapper when it is imported again into another instance. JavaScriptCore, as measured in Bun
  1.4.4, makes a new one, so there the second instance's entry gets its own function id.
- A Memory uses two owner regions, so the default 4,096-region policy allows 2,048 Memories in a
  group, half of native's. Publications are limited to 4,096, as on native.
- Withdrawal is narrower than native's: only the incarnation that published may withdraw.
- `Worker.terminate()` returns before the agent has stopped. A worker blocked in `Atomics.wait`
  stays a listed waiter until Blink forces it out about two seconds later (measured at 2,007 to
  2,011 ms), so a wake sent in that window can count it. The supported stop boundary is the
  broker's successful stop after native terminate returns, and it does not prove the agent's
  readers have closed. Native's "no waiter remains" check holds only once the agent has ended.

`scripts/shared-wasm-memory-browser.test.ts` runs the shared fixture in a real group guest in
Chromium, owned by `checks/browser-guest-shared-wasm-memory.json`. The Shared PIC job consumes
its one group build. The gate tracks the nested host, executor, launcher, runner, worker,
broker, telemetry, trampoline and consumer bundle/dependency inputs. Unrelated page changes
keep their ordinary web gates. The shared producer and native-launcher prerequisite stay blocking.

The published package includes `web/src/nested/` alongside its worker sources,
so packed consumers can resolve the same host and wire types. The existing
packed-consumer gate checks all three files and the real TypeScript/Vite closure.

Native instantiation reads each validated import occurrence in order, including duplicate
names with matching function types. The host supplies those captured bindings through
ordered namespace getters rather than overwriting an earlier callback.

The Browser group fixture shares Memory, Module and SharedArrayBuffer objects through
workerData and MessageChannel, including a receiver blocked with no event-loop turn, a sender
the owner has released before any attachment, ports moved with decoded and with undecoded queued
messages, receivers stopped before and during attachment, and concurrent growth. `page-control.ts`
carries the page's owner-side facts to those fixtures, because a guest's own `process.pid` is a
fixed 1. `ownerReleased` is the broker's supported stop. `agentClosed` is the agent's real end: the
page's test build runs each worker with one Web Lock (`web/tests/shared-wasm-agent/`), reports when
it is actually held, and reports when the browser drops it. A row that uses `agentClosed` must first
pass `agentArmed`, and it refuses if the page cannot observe that agent. Membership rows compare the owner's group id for each kind
of start. After the run the page inspects each retained ended owner and the page budget. A separate
page refuses one member's native terminate and asserts its retained debt.
`web/tests/nested-host-publication.test.ts` runs the real `NestedHost` against Waffle's real owner
for every refusal and rollback, using publications a guest would never make.
`web/tests/nested-host-admission.test.ts` does the same for reservations: each size the rule can
choose, the address ceiling and the backing budget, every refusal with the owner's counters and
charge unchanged, growth at both bounds, and a published reservation's extents. The group fixture
runs `reservation.ts` and `reservation-binding.ts` in their own guests on this host. The second
is the memory descriptor of the published `@oxc-parser/binding-wasm32-wasi` 0.94.0 loader, 4,000
initial and 65,536 maximum pages. It controls admission only.
`web/tests/nested-host-table.test.ts` covers exported tables the same way, on modules assembled
from the `.wat` files beside it (`wasm-tools parse`): identity, entry types, callbacks, every
refusal, growth to both limits, the handle limit, and that a table takes nothing from the owner.
The group fixture runs `table-controls.ts` on both hosts and `global-refusal.ts` on this one.
