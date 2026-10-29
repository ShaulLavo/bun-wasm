# Shared-group programs

A Bun process and its workers can run as one *memory group*: one shared `WebAssembly.Memory`,
with each member's core and engine at their own relocated base. This page is the build and
admission contract. The group itself (members, regions, futex, budgets) belongs to
[Waffle's memory groups](https://github.com/ShaulLavo/waffle/blob/main/docs/memory-groups.md).

## Profiles

`split` is the default profile and is unchanged. `shared-group` is opt-in:

```sh
export BUN_WASM_SHARED_SYSROOT=<J2 shared-pic sysroot>
export BUN_WASM_SYSROOT=$BUN_WASM_SHARED_SYSROOT
source env.sh
BUN_CORE_BUILD_DIR=<dir> bash scripts/build-bun-core.sh --shared-group
QUICKJS_PROFILE=shared-group QUICKJS_BUILD_DIR=<dir> bash scripts/build-engine-quickjs.sh
```

Every guest object is built `-fPIC` with atomics, bulk memory and mutable globals, Rust std
included (`-Zbuild-std`). The only accepted libc is the shared-pic sysroot whose `sbrk` grows
through `runtime_shm.group_grow`. A split build refuses that sysroot, and a shared-group build
refuses any other. JSC is not available in this profile until WebKit and ICU are rebuilt with
atomics.

## Memory ceiling

Bun's wasm32 string tags use address bits 29-31, so every Bun member must stay below 512 MiB.
The core declares its imported memory with an 8192-page maximum. A Bun group is created with
Waffle's `memoryGroups.maximumPages = 8192` and `stackBytes = 8 MiB`. A group memory with a
larger maximum cannot instantiate the core.

## Initialization

1. The host carves the core's data (`dylink.0` memory-info), an 8 MiB stack and a table base.
2. It instantiates the core with `env.memory`, `__memory_base`, `__table_base`, a mutable
   `__stack_pointer` and the member's own table.
3. `core_initialize_memory`, `__wasm_apply_data_relocs`, `__wasm_call_ctors`, in that order.
4. The engine side links through `bun_core_alloc` as in the split profile, then `_start`.

## Admission

`bunwasm-host` and Waffle's link loader refuse a group image that contains `memory.grow` or an
opcode they cannot decode, exports a memory, needs a shared library, still has a start section,
or imports an unshared memory or one whose maximum is not 8192 pages. A pair whose halves disagree
on the profile is refused. A group core cannot run as a single module. There is no bypass.

Receipts of one profile never verify against inputs of the other.
