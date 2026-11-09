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
Single-agent tests are not cross-worker acceptance. JSC uses this contract through
[its record](jsc-shared-group.md). Other embedded engines, stock Vite and
large-memory admission are not delivered here. The Browser host has
[its own record](shared-nested-browser.md).

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
