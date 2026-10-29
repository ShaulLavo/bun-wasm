## 0019 wasm32 string flags beside the pointer

Class **Port**. Upstream is Bun `9510e74152073d850a18758ca41114d8f214ffa6`,
`src/bun_core/string/mod.rs`. Patch
`0019-wasm-store-32-bit-string-flags-beside-the-pointer.patch` replaces patch 0001's
32-bit pointer flags with design A's full pointer, length, and flags byte.
The configured memory maximum remains 512 MiB.

`flags`, `with_flag`, and `addr` hide the width-specific storage. Const
construction and lifetime detachment keep the flags, as do truncation and
substrings. `untagged(ptr)` is available only on 64-bit, where its existing
53-bit mask and high pointer flags remain. Native layouts stay unchanged.
The 32-bit `EncodedSlice` and containing `String` have compile-time size and
alignment assertions. No wasm32 C++ peer uses this representation. Rust FFI
users in `bunwasm-glue` and `bunwasm-build` use the same `bun_core::String` type.

The original verification adapter `scripts/check-encoded-slice.ts` selects the
actual declarations and method bodies from the synchronized vendor source,
including `String`, its union, the WTF payload types, and the FFI layout macro.
It compiles them on native64 and wasm32 and runs the latter under wasmtime.
`tests/encoded-slice/probe.rs` is original test code. Neither file contains a
copied replacement representation. This bounded proof omits unrelated methods
and does not replace compiling all consumers or the coordinated guest suites.

Run from a synchronized checkout after `source env.sh`:

```sh
bun scripts/check-encoded-slice.ts
# An optional Bun revision selects its actual source for the old-red comparison.
bun scripts/check-encoded-slice.ts vendor/bun <revision-before-0019>
```

See [Memory ceiling](../memory-ceiling.md) for capacity stages and dependencies.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0019](#0019-wasm32-string-flags-beside-the-pointer) | Port | Store 32-bit string flags separately so addresses retain every bit. |

[Parent context](bun-patch-series.md).
[Ledger scope and pinned revisions](scope.md).
