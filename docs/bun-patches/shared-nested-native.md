# Shared nested Wasm, QuickJS and native host

Classification: Original host adapters. The runtime's `wasm/nested.rs`, native
host `nested.rs` and `shm/nested.rs`, and QuickJS-side `nested_bridge.rs` and
`nested_token.rs` connect
the existing `bunwasm-nested` regionizer to native execution. No interpreter,
compiler algorithm or upstream runtime implementation is copied into these files.
The QuickJS-ng 0.16.2 source bundled by rquickjs-sys 0.13.0 is adapted in
`quickjs.c` to enable real Wasm atomic operators only with the matching group
build macro, wrap external SAB prefix views, and use the existing cancellable
host wait provider. Default split builds retain the prior atomics selection.

In the same group build, QuickJS allocates each SharedArrayBuffer from its own
region through `JS_SetSharedArrayBufferFunctions` and the core's
`bun_shared_buffer_alloc`. A refused allocation runs `JS_RunGC` once and retries,
because cycles never refcount to zero and regions are outside malloc accounting.
Growable construction is refused, because each wrapper keeps its own length.
The finalizer skips `sab_free` for a `wasm_memory` wrapper, which never owns its
region. Slice refuses a species result over the source's own storage before
copying, comparing storage pointers rather than wrapper objects.

`wasm/shared_buffer.rs` is an original adapter. Each member keeps a ledger from
buffer address to its region's memory handle. A finalizer only queues the region,
so no host request runs during collection. The next allocation returns queued
regions, and member stop releases the rest. Every buffer commits at least one
64 KiB page and takes one region slot. There is no heap fallback.

The shared-group-only ABI is `runtime_nested.request(pointer, length, out) -> i32`.
Requests and replies are the closed serde enums in `wasm/nested_wire.rs`.
Compilation supplies the core-validated regionizer output in an owned input span.
The host reads it atomically from the group. Other requests contain numeric
handles, numeric values and immutable import metadata. Responses are core-owned
transport allocations, returned as `[pointer, length]` and freed by the core.
No JS callback, JS root or thrown object is serialized. An exit or trap from a
reentered core allocator, dispatcher or free entry terminates the member with the
original native error. No reply or cleanup call reenters that unwound core.
These member-fatal diagnostics print the root cause rather than an unbounded
recursive Wasm backtrace. Error contexts preserve the original exit or trap type.
A trap confined to nested Wasm remains catchable, and a pending JS exception
keeps its exact engine-side value. Invocation tokens wrap, skip zero, and avoid
identities still active on the invocation stack. Frame validation checks ownership
without copying the frame, and nested calls refresh shared buffers on access
rather than polling every live memory before and after each callback.

At registration, QuickJS supplies `bun_core_bind_nested(dispatch)` with a code
entry of type `(invocation, callback, frame) -> status`. The core export
`bun_nested_dispatch` checks the active token and exact owned frame allocation
before forwarding, with no registry borrow alive. All execution entries, including
instantiation/start, push an invocation. Depth is bounded at 64. The 520-byte frame
has argument/result counts and 32 slots, each `kind:u32`, zero reserved `u32`, and
numeric bits `u64`. Kinds are i32, i64, f32 and f64. Status 0 means success,
2 means an original engine-side pending exception, and 3 means an invalid frame.
The side owns callback roots and pending values. The generic native-error codec
is used only for ordinary diagnostics, never for the original thrown value.
The callback boundary currently admits numeric values; unsupported references
and mixed-backend resources fail explicitly. SIMD exports can be instantiated,
but a parameter or result of type `v128` throws TypeError before entering Wasm.
Nested immutable Global imports require the exact Global type and mutability,
or an unboxed Number for i32, f32 and f64, or BigInt for i64. The ordinary Wasmi
import path keeps its existing LinkError behavior. Handles have a separate high-bit
backend tag and separate typed registries.

Each nested memory reserves a stable existing group region. The whole reservation
is committed and charged, including one real page for a distinct zero-page memory.
Declared maximum and visible length remain separate. Growth zeros the newly
visible pages atomically before publishing length and never reallocates storage.
Current and old SAB prefix objects stay live. Regions, modules, instances and
callback roots are retained for the member session; resource admission is bounded.
Memory handles encode a slot and generation. Released slots are reused with a new
identity, and a slot retires before its generation wraps. Stale handles cannot
refer to a later reservation. Module, function and published instance handles
remain session-owned.
Failed instantiation releases a newly owned defined memory, never imported memory
or its writes. Member teardown destroys Store instances before releasing region
holds and backing. No finalizer calls back into a destroyed core.

The host wait functions and group-profile QuickJS Atomics use `runtime_shm`'s one
wait queue, keyed by the effective group address within the stable region. Leases
stay alive during synchronous waits. Negative/zero timeout and cancellation retain
the provider's semantics. Ordinary split/native QuickJS uses its ordinary code.
JSC uses this contract through [its record](jsc-shared-group.md). Other embedded
engines, stock Vite and large-memory admission are not delivered here. The Browser
host has [its own record](shared-nested-browser.md) and refuses the transport below.

## Same-region workers (original adapter)

A native worker of a group member is already a member of that group. This adapter
carries Module and Memory identity between members through the codec's existing
`sharedObjects` contract, installed for the embedded polyfill only when the guest is
a shared-group build. `runtime_nested.request` gains `PublishMemory`, `AttachMemory`,
`PublishModule`, `AttachModule` and `Withdraw`.

- `shm` keeps one logical region per memory, shared by every member's lease. Growth
  and page counts live there; bytes and the futex provider are unchanged.
- Each member's lease is its own region hold. The group directory, keyed by a token
  never reused in that group, holds a published region until the publication is
  withdrawn or the group's last member stops. A sender's stop cannot free a receiver's
  bytes. Directory contents are bounded by a per-group publication limit.
- A published module is the host's compiled `wasmtime::Module` and the core's opaque
  description of its JS-visible shape. Receivers instantiate it in their own Store
  with their own callbacks, without recompiling.
- A receiver reuses one local handle per token. Each serialized buffer gets a fresh,
  non-owning wrapper at its posted length, so old prefix views stay prefixes and two
  deliveries are two objects over one set of bytes. Repeated references in one message
  stay one object through the codec's own graph map.
- An ordinary `SharedArrayBuffer` publishes the region its allocation took. Its sender's
  lease follows the JS wrapper rather than the per-token cache, and a member stop or GC
  never frees bytes a publication still holds.

Refused with `DataCloneError` at post time: growable `SharedArrayBuffer`, unshared Memory,
modules on the Wasmi backend, and every WebAssembly Table and Global, which are one
member's capabilities with no clone representation. `structuredClone` refuses Tables and
Globals too.

## Exported tables and globals (original adapter)

`wasm/nested_description.rs` reads each export's type from the original module.
Nested modules may export `funcref` tables and numeric globals. An exported reference
global or non-`funcref` table is a CompileError. `runtime_nested.request` gains
`TableExport`, `TableLength`, `TableGet`, `TableSet`, `TableGrow`, `GlobalGet` and
`GlobalSet`, and the reply `Null`.

Table identity is keyed in the core by instance and export index, so aliases are one
`WebAssembly.Table`. Entries pass through the host's function identity, so
`table.get(i) === exports.fn`. A table index out of range or a refused grow is a
RangeError. `table.set` and `table.grow` accept only functions of this backend; anything
else is a TypeError. No JS root crosses this boundary. Table and function handles are
session-owned and bounded by the same 4,096-resource limit.

Global aliases are one object within an instance. A validated immutable `WebAssembly.Global`
import is kept by its import index, so re-exporting it returns the supplied object, also
across instances and duplicate import slots. A raw numeric import gets a new wrapper per
instance. A `v128` global refuses JS access with a TypeError before any request.

Wasmtime retains instantiation allocations until its Store ends, including an
instance whose start traps. The existing native Store limit remains 40 instances.
The adapter does not increase that ceiling. Import order, function types, callback
limits and immutable global types are checked before any Store wrapper is created.
A rejected user import leaves later valid instantiation available. A catchable
start trap or pending JS exception also leaves admission open. Errors raised by
nested host callbacks carry an execution marker, so an imported start function
that fails without a Wasm backtrace cannot be mistaken for an admission failure. Repeated failed
starts can exhaust the remaining Store slots and produce a LinkError. Once a
prechecked instantiation fails outside execution, later attempts return that
native admission error before allocating more wrappers. This also closes
admission on an unexpected native allocation failure, not on an ordinary invalid
import or thrown start value. At most one failed native admission retains its
wrapper allocations after the Store budget is exhausted. Existing
instances and memories remain usable. Unpublished defined regions and provisional
JS roots are released despite that native metadata retention. The fixture checks
both normal recovery after a failure and explicit bounded Store exhaustion.
Trace counters report attempts and failures, region reservations and visible bytes
separately. These counters are not RSS measurements.

Cold shared-profile CI imports the ordinary Bun patch series without relying on
a runner Git identity. Source synchronization supplies only a command-local
committer; patch authors, patch bytes and verified source trees stay unchanged.

Publication transactions retain their rollback until delivery. Overlapping preparations
share a per-token pending record; a successful inner delivery marks that record as
committed, so an outer getter failure cannot withdraw a token already observed by a
receiver. Only the last abort of an undelivered token removes its directory entry.
The codec commits publication when direct delivery succeeds, before later transfer
finalization can fail. Broker routing commits only after its transaction succeeds.

The core checks serialized request size against the same 1 MiB limit as the native
host before crossing the import boundary, including checked conversion to its
32-bit wire length. A valid module with an oversized publication description is
refused with DataCloneError, rather than trapping at the host import. The discovered
group fixture includes that case and a real reentrant Memory-and-Module delivery.
