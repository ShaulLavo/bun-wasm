# Bun's Wasm memory maximum

Bun core and its QuickJS, JavaScriptCore or SpiderMonkey engine share one wasm32 linear
memory. Its maximum is 1 GiB, or 1073741824 bytes (16384 pages). It was 512 MiB until
stage 1 of the plan below.

A shared-group program runs in a memory group instead: one shared memory that holds
every member of the group and the regions they create. Since stage 2, that group's
address space is 2 GiB (32768 pages), while its members together still hold at most
the 1 GiB guest maximum. Split programs did not change.

Safari allocates requested WebAssembly memory ahead of time, while Chrome and Firefox allocate lazily, so size memory for Safari.

## Two quantities, each with one authority

| Quantity | Authority | Value | What derives from it |
| --- | --- | --- | --- |
| Guest memory maximum | `crates/bunwasm-cli/max-memory.txt` | 1 GiB | Split links, engine heap sizing, the single-memory Store limit, and the pages a group's members may hold together |
| Group address space | `crates/bunwasm-cli/group-address-space.txt` | 2 GiB | The maximum every shared-group core and side declares, and both hosts' group policy |

Each file holds one line of decimal bytes and is the only copy of its number.

`max-memory.txt` is read by:

- the `--max-memory` link argument of a split `bun.wasm`, `bun-build.wasm` and
  `bun-tools.wasm`;
- the native host's Store memory limit for a guest whose Worker sets no
  `resourceLimits`;
- JSC's `forceRAMSize` (`crates/bunwasm-jsc/cpp/helpers.cpp`, which receives
  `BUN_WASM_MAX_MEMORY` from its build script), so JSC sizes its heap for the real
  maximum rather than wasi-libc's wrapped 4 GiB estimate, and SpiderMonkey's GC limit;
- the jsc shell, the QuickJS linker test and the experimental SpiderMonkey G2
  standalone probe and VM-only bootstrap;
- the member cap of a Bun group on both hosts (below).

`group-address-space.txt` is read by:

- the real core linker, `crates/bunwasm-cli/build.rs`, which selects its
  `--max-memory` by explicit build profile: the group address space for
  `BUN_WASM_PROGRAM_PROFILE=shared-group`, the guest maximum otherwise;
- every shared side producer (`scripts/build-engine-quickjs.sh`,
  `scripts/build-engine-jsc.sh`, `scripts/build-engine-spidermonkey-shared.sh`), which
  passes the same `--max-memory` to `wasm-ld`. Without it `wasm-ld` gives a shared
  PIC image a 65536-page maximum;
- both shared-group receipts' link lists (`sharedGroupCoreLink`, `sharedGroupSideLink`);
- the page maximum a shared-group core and side must declare, checked on the decoded
  import when each is converted (`scripts/src/engine-explicit-init.ts`,
  `scripts/spidermonkey-side-core-receipt.ts`) and when the native host admits them
  (`crates/bunwasm-host/src/linked_group.rs`);
- the Bun group policy: `bun_policy()` on the native host and
  `BUN_MEMORY_GROUP_POLICY` (`src/engine-kind.ts`) for Waffle.

Rust reads the files in `crates/bunwasm-cli/max_memory.rs` and
`crates/bunwasm-cli/group_address_space.rs`, TypeScript in
`scripts/src/program-profile.ts`. One parser serves both: it accepts only a page
multiple in (0, 2 GiB], bounding the number before each decimal digit so a long
value cannot wrap, and the group address space may not be smaller than the guest
maximum. Shell consumers get the values from `program-profile.ts max-memory` and
`program-profile.ts group-address-space` before they configure or link anything.

`max-memory.txt` is part of every guest's source manifest and of the JSC prebuild's
input hash. `group-address-space.txt` is inventoried only for shared-group programs
and is in no engine archive's input hash, because no archive reads it: changing it
relinks cores and sides and rebuilds nothing else. `tests/package/max-memory.test.ts`
fails if a consumer gets its own number or reads the wrong authority. There is no
environment variable or flag for either. Changing capacity is a reviewed edit of one
file, one stage at a time.

### The side's declared maximum

A shared side declares the same 32768-page maximum as its core. Import matching
alone does not require that: a module importing a shared memory with a *wider*
declared maximum instantiates against a narrower memory, so a side left at
`wasm-ld`'s implicit 65536 pages would join any group and hide the stage it was
linked for. A narrower one, such as a stage-1 image at 16384 pages, cannot
instantiate at all. The converters and the native host therefore require the exact
value on both halves, and `scripts/src/engine-explicit-init.test.ts` checks the
import-matching rule itself. A pair linked for another stage is refused; there is no
fallback.

### The member cap

Raising the address space must not raise what Bun itself may hold. A Bun group's
policy therefore carries a cumulative member cap of 16384 pages:

- it counts every chunk granted to a member through `group_grow`: image, stack, side
  data, heap and pages a worker was granted and never used, for every reserved,
  launched or retained member;
- it is charged after a chunk is placed and returned only when a member is released
  or an admission is aborted. A member whose stop failed stays charged;
- regions (shared `WebAssembly.Memory`, `SharedArrayBuffer`) are not counted;
- a grow past it is an ordinary `NoMem` that changes nothing;
- a policy without a cap gets the group's own configured maximum, derived when the
  group is created. An explicit cap is a positive page count no greater than that
  maximum.

The cap keeps the aggregate envelope a 1 GiB group gave its members. It is not a
per-engine heap limit and it reserves nothing for later workers. It cannot refuse an
allocation that fit a 1 GiB group, which held its members, page zero and its regions
together. The backing budget is a separate ledger: it stays 2 GiB for all groups of
one runtime, counts regions, and keeps a group's high-water charge until the group's
backing is dropped.

## Why it was 512 MiB

Bun's `EncodedSlice` stored three flags in address bits 29, 30, and 31 on wasm32.
UTF-8, global allocation, and UTF-16 flags left only 29 address bits. An address
at or above 512 MiB could become a flag and decode to the wrong address. The cap
prevented that corruption.

Patch [0019](bun-patches/0019-wasm32-string-flags.md) implements design A.
On 32-bit targets, `EncodedSlice` stores the full pointer and a separate flags byte.
It grows from 8 to 12 bytes, and its containing `bun_core::String` grows from
12 to 16 bytes. Native64 keeps its existing layout and pointer flags.
All Rust users compile against the same definition. The wasm32 hosts exchange
addresses and bytes, not either string structure. Native C++ peers keep their
existing layout.

## What a maximum does not mean

The maximum is how far memory may grow, not what a guest starts with or uses.
Cores still start small. A larger maximum does not establish Next.js, SolidStart
or Vite acceptance, nor that a device can supply the memory. Waste and retention
fixes remain necessary regardless of capacity.

JSC's `forceRAMSize` doubled with stage 1, so JSC collects garbage later and its
peak memory can rise. That must be measured per engine.

Stock Rolldown constructs
`new WebAssembly.Memory({ initial: 16384, maximum: 65536, shared: true })`:
1 GiB at construction, with no option to ask for less. Inside a Bun guest that
memory is a region of the guest's memory group, so it needs those 16384 pages
**plus** every Bun member's own image, stack and heap. A 16384-page group could not
hold it. A 32768-page group does: the region takes its initial pages and 1024
pages of growth room (17408 pages) and the members share what is left. That
admits the memory. It does not establish that Vite runs: a second such memory in
the same group is refused, the reservation is charged in full to the 2 GiB
backing budget, and JSC's and SpiderMonkey's use beside it is unmeasured. The
browser engine's native `WebAssembly.Memory` is outside all of this.

### What a larger declared maximum costs

A memory's declared maximum is address space the host process may reserve when the
memory is created, whatever is committed later. Raising a group's maximum from
1 GiB to 2 GiB therefore costs each group up to 1 GiB more reserved address space,
with its member cap and resident memory unchanged. On Node and Bun that reservation
was measured as free. On WebKit, shared memories reserve their declared maximum
inside one process-wide cage, so the count of groups alive at once matters there.
This is unmeasured on iPhone, and the member cap does not limit it.

What creates and ends a group:

| Group | Declared maximum | Created | Ends |
| --- | --- | --- | --- |
| A shared-group Bun process | 32768 pages | When the process starts | When its last member has stopped and its host Store has dropped |
| Its `worker_threads` workers | None of their own | They join the parent's group | With the parent's group |
| Any other spawn of a shared-group program (`Bun.spawn`, a package script, a tool's child) | 32768 pages each | When the child starts | When the child's last member has stopped |
| A split Bun process | No group; one memory of at most 16384 pages | When the process starts | When it exits |

Waffle's group policy is runtime-wide, so every other memory group in a page that
hosts Bun groups also declares 32768 pages. A member whose stop failed keeps its
group and its declaration alive. A stage-2 acceptance run must record both ledgers:
granted member and region pages with the backing high-water, and the declared
maxima of every group alive or retained at the same time.

## Stages

- **512 MiB, stage 0 (done):** the new representation. Actual-source tests
  (`scripts/check-encoded-slice.ts`) check layouts, constructors, substrings,
  truncation, lifetime detachment, and synthetic addresses through `0xffffffff`
  without dereferencing them.
- **1 GiB, stage 1 (the guest maximum):** one authority for every consumer, and the
  checks below.
- **2 GiB, stage 2 (shared groups only):** the group address space, with the
  member cap keeping Bun's own share at stage 1, and the checks below. Split
  guests, `bun-build`, `bun-tools` and every engine's heap sizing stay at stage 1.
  Moving them is a separate decision that needs each engine's safety and workflow
  checks at the larger heap.
- **Above 2 GiB, stage 3:** first normalize exported and imported i32 pointers to
  unsigned addresses in Waffle and bun-wasm's browser host. Waffle's fix must land
  before updating its dependency pin. Then check high-address I/O and host results
  and repeat the engine gates, up to wasm32's 4 GiB address space. Both readers
  refuse values above 2 GiB until then.

### Stage-1 checks

- `scripts/check-encoded-slice.ts` (blocking `rust` CI job) links its wasm32 probe
  of the actual `EncodedSlice` and `String` source at the maximum. It grows memory,
  places Latin-1, UTF-8 and UTF-16 bytes at and above `0x20000000`, decodes them
  through Bun's readers, and moves them through WASI `fd_write` and `fd_read` with
  iovecs, buffers and result cells above 512 MiB. It then checks that the top of
  the maximum is usable and one more page is not. Source from before patch 0019
  fails it, and so does a 512 MiB link.
- `tests/fixtures/strings-above-512mib` runs on the produced guests: QuickJS in
  the native fixture checks and JSC in `scripts/jsc-embedding.ts`, both blocking.
  It fills memory past 560 MiB with 16 MiB blocks, measured by the core's
  `linearMemoryBytes` because engines report `rss` differently (JSC: null), so later 17 MiB allocations
  come from above them. `bunStringRoundTrip` (`bun:internal-for-testing`) wraps
  such a copy in Bun's own `String`, decodes it through `EncodedSlice`, and
  reports the address; the fixture requires it at or above `2**29` with identical
  bytes for each encoding. Transpile and build outputs must also match a run
  without ballast.
- `tests/fixtures/gc-large-cyclic-garbage` passes 1.5 GiB of cyclic garbage
  through the 1 GiB guest, so it still requires collection.
- Not covered by CI: each engine's app, retention and memory gates, JSC's peak
  against the earlier 512 MiB runs, a real 16384-page shared-group pair, and
  device availability.

### Stage-2 checks

At 2 GiB the last valid byte is `0x7fffffff`. The one-past-end address
`0x80000000` is legal as a range end or a stack top, and is `i32::MIN` in the i32
globals and arguments that carry it.

- `crates/bunwasm-host/src/linked_group_boundary_tests.rs` fills a real Bun group
  exactly: page zero, the Rolldown reservation, and a member whose stack is the
  last chunk. Through the production carve, core instantiation, preview1 view,
  guest memory accessor and `runtime_shm` imports it checks the stack top at
  `0x80000000`, the final word and byte, iovecs, data and result cells in the final
  page, spans that reach or wrap past the end, and that one more page or region is
  refused with the owner's accounting unchanged, then that everything is returned.
- `crates/bunwasm-host/src/shm/member_cap_tests.rs` checks the cap: two members
  reaching it together, a refused or failed grow leaving state identical, release
  and reuse, a partial admission, a retained member, regions, and the default for a
  custom maximum.
- `web/tests/group-address-space.test.ts` does the same on the Browser host's
  adapters: Waffle's group owner under `BUN_MEMORY_GROUP_POLICY`, the real nested
  host and Waffle's preview1 over the group memory.
  `web/tests/spidermonkey-group-stack.test.ts` runs the Browser executor with a
  member stack whose top is `0x80000000`.
- `tests/fixtures/shared-group-address-space` runs on real shared-group guests on
  both hosts, on every engine the shared job builds. It constructs Rolldown's
  descriptor, requires a second one to be refused whole, reads and writes a file
  from views at the top of the region, shares the memory with a worker, fills the
  group to within 208 MiB of its end and round-trips Latin-1, UTF-8 and UTF-16
  through Bun's own `String` there. A second guest fills its heap until the member
  cap refuses with an ordinary failure, then requires a shared buffer to still be
  admitted.
- Not covered: Safari and iPhone, where reserving a 2 GiB shared maximum and a
  1.06 GiB charged reservation are unmeasured; a Vite lifecycle; and JSC's and
  SpiderMonkey's peak beside the reservation.

At every increase, record successful growth and allocation failures on desktop
browsers and iOS Safari. A synthetic pointer test does not establish device
availability. Rust's single-allocation limit and each engine's string and
ArrayBuffer limits also remain.

## The wasm64 alternative

Memory64 uses 64-bit addresses and could avoid wasm32's 4 GiB address space limit.
It is a separate port, not a linker setting. It requires checking Rust, the WASI
SDK and sysroot, QuickJS, JSC, the Wasm interpreter, and Waffle's host interfaces,
including BigInt addresses. Browser support, especially Safari on macOS and iOS,
toolchain readiness, and memory-heavy performance have not been established. No
wasm64 support or speed claim is made here.

For other constraints, see [Limits](limits.md).
