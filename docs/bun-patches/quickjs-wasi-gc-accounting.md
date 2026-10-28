## QuickJS memory accounting on WASI

Class **Port**. This changes `quickjs/cutils.h` from the QuickJS-ng source bundled by rquickjs-sys 0.13.0. The local file is `third_party/rquickjs-sys/quickjs/cutils.h`. rquickjs-sys 0.14.0 bundles the same two lines upstream, so this backports them rather than adding new logic.

`js__malloc_usable_size` returned 0 on every target except Apple, Windows, Linux and FreeBSD, including wasm32-wasip1. QuickJS counts small blocks by arena size, but large blocks (long strings, bytecode, `ArrayBuffer` storage) by the usable size. Each large block therefore counted as 8 bytes. The GC runs when the counted size passes a threshold, so large garbage held in reference cycles never triggered it. A Next.js dev server reloads its 5.6 MiB vendor chunk after each compile. The dropped modules form such cycles, so the guest grew toward its 512 MiB limit and failed with `terminal core transport failure 3` (the core could not allocate a reply). `process.memoryUsage().heapTotal` undercounted for the same reason.

On WASI the header now includes `malloc.h` and returns `malloc_usable_size`, as upstream does. The production core exports `malloc_usable_size` from wasi-libc's dlmalloc, the allocator the shared QuickJS module already imports `malloc` from (`scripts/quickjs-core-exports.txt`).

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`third_party/rquickjs-sys/quickjs/cutils.h`, `js__malloc_usable_size`](#quickjs-memory-accounting-on-wasi) | Port | Use wasi-libc's `malloc_usable_size`, so large blocks count toward the GC threshold. |
| [`scripts/quickjs-core-exports.txt`, `malloc_usable_size`](#quickjs-memory-accounting-on-wasi) | Port | Export the core allocator's usable-size query to the shared QuickJS module. |

[Existing QuickJS host patches](quickjs.md).

[Ledger scope and pinned revisions](scope.md).
