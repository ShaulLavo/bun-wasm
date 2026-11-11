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

## Explicit page selection and assets

The playground and sandbox accept `?engine=quickjs&profile=shared-group` and
`?engine=jsc&profile=shared-group`. Omitted `profile` means `split`. Engine kind and memory
profile are separate selections. Invalid profiles, unavailable engine/profile combinations,
missing assets and mixed pairs fail before the program executes. An execution failure never
changes the selected profile. Browser and experimental SpiderMonkey shared programs are not
available through this selector in this host revision.

Both page builds consume existing complete shared producer directories through
`SHARED_QUICKJS_PROGRAM` and `SHARED_JSC_PROGRAM`. Each directory contains `bun.wasm`, its
named engine side, `bun-core.wasm.core.json`, the side's `.engine.json` and `source.txt`.
These are inputs from `scripts/build-native-profile.ts`, not another build. Staging uses
the production program validator and preserves original receipt bytes. A JSC producer's
`bun.wasm` is served as `profiles/shared-group/bun-jsc.wasm.gz`; its side remains
`profiles/shared-group/jsc-engine.wasm.gz`. QuickJS uses `bun.wasm.gz` and `quickjs.wasm.gz`
in the same profile directory. Original receipts live under `receipts/<engine>/` there.

The embedded build map and `engine-builds.json` fingerprint the full profile-relative paths.
Shared fetch and byte-cache URLs also carry the profile, including custom `wasm` URLs;
split retains its original URLs. Prepared
program identity includes the engine and both exact module digests, so different profile
bytes cannot share a compiled program. Service-worker forwarding preserves paths and queries.
Shell commands and workers resolve the selected prepared program in the page's single runtime.
Both pages pass `BUN_MEMORY_GROUP_POLICY` from `src/engine-kind.ts` to `createRuntime`.

For maintained goals, prepare with
`bun scripts/goals-matrix/prepare.ts /absolute/delivery --profile=shared-group`.
Supply the shared producer directories above, or include the complete profile assets and
receipts under `delivery/web/profiles/shared-group/`. Also set `BASH_WEB_GUESTS_DIR` to the
current pinned shell's original complete producer directory. Preparation verifies that shell's
receipt and bytes independently of the Bun guest source, and does not overwrite it with a donor's
older shell after building. Run with
`--profile=shared-group --engines=quickjs,jsc`. The runner records the profile in result
asset identity, verifies the running page's profile, and passes it to fleet runners. Resume
requires the same source, profile and asset identity. Split remains the default for both commands.
Preparation records the independent host, Bun guest and shell sources and writes
`goals-site-inventory.json`. Campaigns verify that closed inventory, including the host code,
shell, profile assets and original receipts, before starting any framework.

This selector uses the current authoritative policy. A group's declared maximum and the
page's group count are separate facts from granted member/region backing. A member cap does
not bound process-wide virtual reservation. Ordinary Bun subprocesses create separate groups;
workers join their parent's group. Stage-2 capacity and native iPhone acceptance are separate work.

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
stops, so a sender's exit cannot free bytes another member can still receive. An ordinary
`new SharedArrayBuffer()` takes its own region on a group guest and is sent the same way, as a
fresh wrapper over the same bytes. Anything else is a `DataCloneError` when it is posted, including
a growable buffer, a table and a global. See [the native record](bun-patches/shared-nested-native.md).

A shared Memory's storage is one stable contiguous range chosen when it is created. The native host
reserves the declared maximum when it fits. Otherwise it needs the initial bytes to fit, and adds
optional growth room that yields to what the group and backing budget have left. The selection is
atomic, holes are never added together, and a reservation never moves or shrinks, so admission is
first-come: growth below the declared maximum, and a later worker's memory, can be refused because
of what was admitted earlier. The declared maximum stays the limit used for import matching. The
Browser host follows the same rule through Waffle's exact-length regions, so its optional growth
room is chosen in steps rather than as half of what is left.

## Processes on the Browser host

The page admits a group core as the first member of a new group. A `worker_threads` Worker joins
its parent's group, and any other spawn starts its own. Members share WebAssembly objects by
reference, as on the native host. The runtime that hosts it needs the `memoryGroups` policy above
(`BUN_MEMORY_GROUP_POLICY` in `src/engine-kind.ts`). Browser workers share the parent's 1 GiB, and
each Memory's reservation is committed in full when it is created. A shared-backend module may
export its function tables on both hosts. One that exports a global loads on the native host only.
[The Browser nested host record](bun-patches/shared-nested-browser.md) lists how it differs from
the native host.

