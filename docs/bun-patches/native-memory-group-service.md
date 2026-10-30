## Native memory-group service

Class **Host feature**, **original adapter** in
`crates/bunwasm-host/src/shm.rs` and its Rust tests. No Bun, Node, WebKit or Waffle
implementation is copied. The matching contract is Waffle PR
[207](https://github.com/ShaulLavo/waffle/pull/207) at
`6a815cb2a5e7d48e01475e4d00be0b55237bfc43`, specifically
`packages/waffle/group/{protocol,state,member}.ts` and `docs/host-abi.md`.

The native service owns typed member incarnations, regions, holds, routed transit
pins, futex waiters and watches over one Wasmtime `SharedMemory`. It does not copy
shared bytes or expose Rust slices for concurrent mutation. Region addresses stay
fixed while their backing is live. The initial policy preserves 16 member slots,
parallelism 1 and the wasm32 4 GiB address maximum. `GroupBackingBudget` is shared
by every group owner on the page, with a 2 GiB default at the runtime composition
boundary. Initial and grown backing is charged once, external growth is reconciled
before further admission, and charges leave only with their backing owner.
Physical-stop failure retains the member's memory and ownership debt;
only settlement of the same incarnation releases it.

### Frozen guest ABI

The `runtime_shm` imports use guest `u32` addresses and negative WASI errno values.

```text
group_grow(pages) -> old page index
shm_create(len, align, out{handle, addr}) -> status
shm_attach(handle, out{addr}) -> status
shm_detach(handle) -> status
shm_pin(handle, out{pin}) -> status
shm_route(pin, pid) -> status
shm_accept(pin, out{handle, addr, len}) -> status
shm_unpin(pin) -> status
futex_wait32(addr, expected: i32, timeout_ns: i64) -> status
futex_wait64(addr, expected: i64, timeout_ns: i64) -> status
futex_wake(addr, count) -> number woken
futex_watch(addr, expected: i32, out{id}) -> status
futex_unwatch(id) -> status
parallelism() -> i32
```

Output spans are checked before owner state changes. Synchronous waiters wake
first, then pending watches in registration order. Each watch is hit once and
stays ready until unwatched. Poll kind 7 carries its typed watch ID. Wait
registration performs the atomic value comparison and queue insertion under one
owner lock. Zero deadlines settle after comparison without entering the queue, and
wake skips expired registrations without consuming its count. Dropping an unsettled
registration removes it. Cancellation settles only the selected waiter with WASI
`-EINTR`. Guest Atomics and nested Wasm imports use this one native queue, never a
second Wasmtime futex table.

### J3 and nested-Wasm binding

J3 owns PIE admission and `linked.rs`. It constructs one runtime
`GroupBackingBudget`, passes a clone to every `MemoryGroup::new`, and retains a
`SharedMemoryLease` in every host Store. The only raw binding is the explicitly
unsafe `SharedMemoryLease::memory_for_admission()`; its contract requires the lease
to outlive every raw clone and admitted instance. J3 installs the matching
`MemberLease` in `Host::shm`. Registered waits bind their
incarnation-specific cancellation handle to `Host::cancel`; a fatal stop interrupts
the blocked guest before physical-stop release. `MemberLease::wait_cancellation()`
provides the same current-wait control to a host stop controller without releasing
regions or member memory.
Until that admission exists, `Host::shm` is `None` and the registered host API
returns `-ENOTSUP`; there is no private-memory or legacy-protocol fallback.
Member launch abortion, failed physical stop and successful physical stop are
separate operations.

### Poll kind 7 and process identity

`runtime_proc.poll` on both the guest slot path and the preview1 delegate path accepts kind 7
for a group member and answers it from `MemberLease::poll_watch`; outside a group it is
`-EINVAL`, and another member's watch is `-EBADF`, as in Waffle. A watch registered by the guest
import stores the polling process's `Notify` as a `Waker`; the `futex_wake` that hits it wakes
that waker after the group lock is released, so the poll returns at once instead of at its
10 ms rescan. A member's release drops its watches. `runtime_proc.getpid` returns the process's
own pid, the one its parent's spawn returned (Waffle `docs/host-abi.md` "PID").

The J11a nested imports `wait32`, `wait64` and `notify` call the same member lease
methods as the guest ABI. The nested adapter owns its additional plain-memory
rule: waiting on plain memory traps and notification returns zero before entering
this shared-memory service.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Native memory-group service](#native-memory-group-service) | Host feature | Original Wasmtime shared-memory owner, exact routed-pin/watch ABI, unified futex queue and standalone concurrency tests. Poll kind 7 with a waking watch and `runtime_proc.getpid` mirror Waffle's contract (`docs/host-abi.md` "Memory group imports", "PID"); no Waffle code copied. |

[Ledger scope and pinned revisions](scope.md).
