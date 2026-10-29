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
parallelism 1, a 2 GiB committed-backing budget and the wasm32 4 GiB address
maximum. Physical-stop failure retains the member's memory and ownership debt;
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
owner lock. Cancellation settles only the selected waiter with WASI `-EINTR`.
Guest Atomics and nested Wasm imports use this one native queue, never a second
Wasmtime futex table.

### J3 and nested-Wasm binding

J3 owns PIE admission and `linked.rs`. It binds `MemoryGroup::shared_memory()` as
the imported group memory and installs the matching `MemberLease` in `Host::shm`.
Until that admission exists, `Host::shm` is `None` and the registered host API
returns `-ENOTSUP`; there is no private-memory or legacy-protocol fallback.
Member launch abortion, failed physical stop and successful physical stop are
separate operations.

The J11a nested imports `wait32`, `wait64` and `notify` call the same member lease
methods as the guest ABI. The nested adapter owns its additional plain-memory
rule: waiting on plain memory traps and notification returns zero before entering
this shared-memory service.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Native memory-group service](#native-memory-group-service) | Host feature | Original Wasmtime shared-memory owner, exact routed-pin/watch ABI, unified futex queue and standalone concurrency tests. |

[Ledger scope and pinned revisions](scope.md).
