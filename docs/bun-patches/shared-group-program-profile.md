# Shared-group program profile

Opt-in build profile for memory-group members: a PIE core and an atomics QuickJS side that run
in one shared `WebAssembly.Memory` with other Bun processes. The default `split` profile keeps its
flags and receipt shape (no profile field is recorded); its input digests change whenever the
inventoried sources do, these helpers included. Contract: [Shared-group programs](../shared-group-profile.md).

No upstream implementation is copied. The admission rules mirror Waffle's group loader contract
(Waffle `11d5553`, `packages/waffle/link/plan.ts` `groupAdmission`, `link/code.ts`): refuse
`memory.grow` in any function body and any memory export. bun-wasm implements them in Rust with
`wasmparser`'s own decoder rather than porting Waffle's TypeScript scanner. The load order follows
the start function wasm-ld 23.1.0 (wasi-sdk 34) emits for a `-pie --shared-memory` image:
`__wasm_apply_global_relocs` then `__wasm_init_memory`, with `__wasm_apply_data_relocs`
exported separately.

| Source | Class | Change |
| --- | --- | --- |
| `scripts/src/program-profile.ts`, `crates/bunwasm-cli/shared-group-link.txt` | Host feature | Original profile types, flags, J2 sysroot identity check, split/shared sysroot separation, and the selected C++ runtime member proof read from the core's link map. |
| `crates/bunwasm-cli/build.rs` | Host feature | Original PIE member link (`-pie --experimental-pic --import-memory --shared-memory --import-table`, plus `--max-memory` from `max-memory.txt` as for every core) and PIC+atomics split entry and allocator telemetry objects, selected only by `BUN_WASM_PROGRAM_PROFILE=shared-group`. |
| `crates/bunwasm-crypto-sys/build.rs` | Host feature | BoringSSL configured with PIC+atomics flags under the profile, a profile stamp refusing reuse of another profile's build directory, and C++ runtime archives linked by exact file name so a PIE never depends on `libc++abi.so`. |
| `scripts/build-bun-core.sh`, `scripts/build-engine-quickjs.sh` | Host feature | `--shared-group` / `QUICKJS_PROFILE=shared-group` producers: `-Zbuild-std`, `--shared-memory`, `--enable-threads`, group finalization. |
| `scripts/src/engine-explicit-init.ts` | Host feature | Original core converter (start → `core_initialize_memory`) and a group side variant that never re-exports the group memory. |
| `scripts/guest-core-receipt.ts`, `scripts/guest-engine-receipt.ts` | Host feature | Profile recorded only for `shared-group`, checked before the input digest. |
| `crates/bunwasm-host/src/linked_group.rs`, `crates/bunwasm-host/src/linked.rs`, `crates/bunwasm-host/src/linked_preview1.rs` | Host feature | Original wasmtime admission; member core instantiation into the group memory via the `shm` service's `SharedMemoryLease`, with chunks carved through its `MemberLease`; side linking into the member's memory, table and stack pointer with base-relative `GOT.mem` rebasing (Waffle `link/group.ts` `relativeExports` contract, reimplemented); a per-member preview1 view that re-exports the group memory (Wasmtime 39 wiggle reads the caller's `memory` export); root group creation on one runtime-wide budget and worker admission into the parent's group. |
| `crates/bunwasm-host/src/guest.rs`, `crates/bunwasm-host/src/slots.rs`, `crates/bunwasm-host/src/process/wasi.rs`, `crates/bunwasm-host/src/process/mod.rs`, `crates/bunwasm-host/src/main.rs` | Host feature | One private-or-shared guest memory boundary for every host import (shared bytes through atomic cells and owned copies, held as the group lease); delegate adapters with a shared-memory variant; a member Store's owner holds the group backing past the Store and settles the member after `Store::into_data`. |
| `src/engine-kind.ts`, `src/quickjs-program.ts` | Host feature | Pair profile agreement from the side's `env.memory` import and the group core initialization order. |
