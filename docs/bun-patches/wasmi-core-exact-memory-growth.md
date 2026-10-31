## Wasmi Core exact memory growth

Class **Port**. `third_party/wasmi_core` copies the published Wasmi Core 0.46.0 crate
(archive SHA-256 `909e4dcf38f60274b2d098802371e232d92c2c612b0b47a0016ec5234a3f425d`),
upstream `crates/core` at revision `50ac76771d631f642e8c4c61bf44c99546024461` in
`wasmi-labs/wasmi`. The MIT and Apache license files are copied from `third_party/wasmi`,
which takes them from that revision; the crate archive omits them. Cargo uses this local
crate through `[patch.crates-io]`.

Local changes are limited to `src/memory/buffer.rs`:

- `ByteBuffer::grow_vec` reserves exactly the new size (`try_reserve_exact`) instead of
  amortized doubling (`try_reserve`).
- A unit test asserts that sixteen 4 MiB growths each leave the capacity equal to the length,
  with the added bytes zeroed.
- A refused growth hands the allocation back to the `ByteBuffer`. Upstream returned early and
  dropped the temporary `Vec`, freeing the buffer it still pointed to and freeing it again on
  drop. A unit test grows by `usize::MAX` (a capacity overflow, so nothing is allocated) and
  checks the buffer keeps its pointer, length, capacity and bytes.

These tests run in the single Rust test command (`scripts/quality-rust.ts` selects
`-p wasmi_core`), since path-patched crates are not workspace members.

Every WebAssembly memory a guest program creates is a Vec inside the bun.wasm linear memory,
which was capped at 512 MiB when this change was made (now the guest maximum in
`crates/bunwasm-cli/max-memory.txt`). With doubling, a memory held twice its size in reserve, and a reallocation needed the
old block and the doubled one at once. In a fresh QuickJS guest a memory stopped growing at
160.1 MiB while the guest had used 315 MiB. esbuild-wasm's Go runtime grows in 4 MiB arenas and
reported `out of memory: cannot allocate 4194304-byte block (70549504 in use)`. Exact growth may
copy more often when the block cannot extend in place; each copy is bounded by the memory size.
All other retained upstream files are unchanged.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Wasmi Core exact memory growth](#wasmi-core-exact-memory-growth) | Port | Reserve exactly the grown size for Vec-backed linear memories. |

[Ledger scope and pinned revisions](scope.md).
