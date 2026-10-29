# Nested WebAssembly regionizer

`bunwasm_nested::regionize(bytes: &[u8]) -> Result<RegionizedModule, CompileError>`
validates, admits, rewrites, and validates one core module. It does not execute it.
`RegionizedModule` contains `bytes: Vec<u8>` and `memory: Option<MemoryPlan>`.
`MemoryPlan` records `initial_pages: u32`, `maximum_pages: Option<u32>`,
`shared: bool`, and `original_import: Option<ImportName>` (owned `module` and `name`).
`CompileError` contains `kind: CompileErrorKind`, `offset: Option<usize>` and
`message: String`. Kinds are `InvalidInput`, `Unsupported`, and `InvalidOutput`.
These Rust types and the imports below are the J11a contract for the host integrations.

## Imports

The output preserves the original function imports and immutable numeric global
imports. Original memory imports and definitions become a single canonical memory
import. Inputs cannot use the reserved `bunwasm_region` namespace.

| Import in `bunwasm_region` | Wasm type | Host meaning |
| --- | --- | --- |
| `memory` | wasm32 memory, min 0, max 65,536 pages, original shared flag | Group memory; present only when the input has memory |
| `base` | immutable i32 global | Page-aligned region base, unsigned |
| `bound0` | immutable i64 global | Initial current region byte length |
| `length` | `() -> i64` | Current byte length; never decreases |
| `grow` | `(i32) -> i32` | Unsigned region page delta, previous page count or -1 |
| `pages` | `() -> i32` | Current region page count |
| `wait32` | `(i32, i32, i64) -> i32` | Checked group address, expected, signed nanosecond timeout |
| `wait64` | `(i32, i64, i64) -> i32` | Checked group address, expected, signed nanosecond timeout |
| `notify` | `(i32, i32) -> i32` | Checked group address, unsigned wake count |

The six function imports and two globals are present even in a memoryless module.
The host owns all these imports. Guest JavaScript never supplies them. Original
memory exports refer to the group in the binary; the integration must return the
region's JavaScript memory object instead of exposing that group export.

## Region invariants

The host admits a region satisfying its original memory limits. Length is a
multiple of 65,536, never decreases, and fits the reservation. The reservation and
`base` satisfy `u64(base) + reservation <= 2^32` and fit the group backing.
`bound0` is the actual length on instantiation. `length`, `pages` and `grow` describe
this same region. Failed growth does not change it. The host bounds growth by the
original maximum and reservation, and zeroes newly committed region bytes before
publishing the new length. Sharing and every region alias follow the same owner.
A plain memory requires a plain group memory; a shared memory requires a shared
one. This crate does not change the current unshared executor.

The host futex service implements all three wait imports on its one queue, including
cancellation. It must preserve the source memory's wait semantics. A wait on a
plain memory traps; a notification on a plain memory returns zero. No wait or
notification instruction remains native. Addresses include the memarg offset and
base; the compiler checks bounds and natural alignment before calling the service.

## Supported input

One wasm32 memory or no memory, ordinary function types, numeric operations,
reference types, multi-value, tail calls, fixed SIMD, threads and bulk memory.
Both validation passes use an explicit wasmparser feature set. The operator
allowlist is closed. Memory64, multi-memory, imported tables, mutable or reference
global imports, exception handling, GC, relaxed SIMD, custom page sizes, extended
constant expressions and unknown instructions are rejected. Active data offsets
must be `i32.const` or `global.get` of an imported immutable i32 global.

Every access widens the unsigned address before adding its offset and width.
A mutable per-instance length cache refreshes only after a failed check. Monotonic
growth makes an older cache conservative. Bulk copies check both region ranges
before writing; `memory.init` retains the native source-segment check. Active data
segments become passive. A generated start preflights every destination, copies
and drops those segments, then calls the original start. Original function/global
indices, element initializers, exports and start references are remapped.
