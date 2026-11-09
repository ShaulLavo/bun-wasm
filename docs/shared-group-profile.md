# Shared-group programs

A Bun process and its workers can run as one *memory group*: one shared `WebAssembly.Memory`,
with each member's core and engine at their own relocated base. This page is the build and
admission contract. The group itself (members, regions, futex, budgets) belongs to
[Waffle's memory groups](https://github.com/ShaulLavo/waffle/blob/main/docs/memory-groups.md).

## Profiles

`split` is the default profile. Its flags and receipt shape are unchanged: no profile field is
recorded. Its input digests still follow the inventoried sources, which now include the profile
helper and the core converter. `shared-group` is opt-in:

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
refuses any other.

JSC has its own matching producer, in a separate build directory:

```sh
JSC_PROFILE=shared-group JSC_BUILD_DIR=<dir> bash scripts/build-jsc.sh
JSC_BUILD_DIR=<dir> bun scripts/build-native-profile.ts shared-group <output> jsc
```

It rebuilds WebKit, ICU and libc++ with atomics. [Its record](bun-patches/jsc-shared-group.md)
lists what changes. The SDK's own libc++ archives have no atomics, and `wasm-ld` refuses them
under `--shared-memory`.

## Memory ceiling

A group's address space is the guest memory maximum, `crates/bunwasm-cli/max-memory.txt`
(1 GiB, 16384 pages, at stage 1; see [Memory ceiling](memory-ceiling.md)). The core declares its
imported memory with exactly that page maximum, so a group memory with another maximum cannot
instantiate it, and a core linked for another stage is refused.

Waffle's `memoryGroups.maximumPages` and `stackBytes` are runtime-wide options: every group in
one `createRuntime()` uses the same policy. A runtime that hosts Bun groups must opt in with
`createRuntime({ memoryGroups: { maximumPages: 16384, stackBytes: 8 << 20 } })`, and that also caps
every other group in the same runtime at 1 GiB. Waffle's defaults (4 GiB, 1 MiB stacks) still
apply to runtimes that don't set them. A Waffle runtime left at the defaults cannot admit a Bun
core: the import check fails. There is no fallback. One consequence: stock Rolldown's 1 GiB initial nested memory cannot be a
region of a 1 GiB Bun group, because the members need room too. That needs the 2 GiB stage.

On wasmtime, a Bun group is an `shm::MemoryGroup` created with `GroupPolicy { maximum_pages }` at the guest maximum; the service default (65536) refuses the core the same way.

## Initialization

1. The host carves the core's data (`dylink.0` memory-info) and an 8 MiB stack through the
   member's lease (`group_grow`), and gives the core its own table with slot 0 null.
2. It instantiates the core with `env.memory`, `__memory_base`, `__table_base`, a mutable
   `__stack_pointer` and the member's own table.
3. `core_initialize_memory`, then `__wasm_apply_data_relocs`, at instantiation.
4. Host imports are installed as for a split core, then `__wasm_call_ctors`.
5. The engine side links through `bun_core_alloc` into the member's memory and table. Its
   `__stack_pointer` is the member's, and its `GOT.mem` cells add the member's `__memory_base`
   to the core's constant data exports. Then `_start`.

## Admission

`bunwasm-host` and Waffle's link loader refuse a group image that contains `memory.grow` or an
opcode they cannot decode, exports a memory, needs a shared library, still has a start section,
or imports an unshared memory or one whose maximum is not the guest maximum in pages. A pair whose halves disagree
on the profile is refused. A group core cannot run as a single module. There is no bypass.

Receipts of one profile never verify against inputs of the other.

## Processes on the native host

A shared-group program started by `bun-wasm` becomes the first member of a new group (the
guest maximum) on one runtime-wide backing budget. A worker it spawns reserves its slot in the parent's
group before the worker thread exists, and gets `EAGAIN` when the group is full. Any other spawn
of a group program starts its own group. Host imports read and write a member's memory only
through atomic cells and owned copies. The group backing outlives the member's Store, and the
member is released once its thread has stopped and its instances are destroyed. A fatal signal
interrupts a member blocked in a futex wait.

Members of a group share WebAssembly objects by reference. `postMessage` and `workerData` publish
a shared `WebAssembly.Memory` or a shared-backend `WebAssembly.Module` in the group's directory,
and the receiver leases the same region and compiled code. Memory buffers keep their length when
sent, so an old prefix stays a prefix. A publication holds its region until the last member
stops, so a sender's exit cannot free bytes another member can still receive. Anything else is a
`DataCloneError` when it is posted, including a plain `new SharedArrayBuffer()`, whose storage is
the sender's own heap on this host. See [the native record](bun-patches/shared-nested-native.md).

## Processes on the Browser host

The page admits a group core as the first member of a new group, and a spawned group core
starts its own group. The runtime that hosts it needs the `memoryGroups` policy above.
[The Browser nested host record](bun-patches/shared-nested-browser.md) lists how it differs
from the native host.

