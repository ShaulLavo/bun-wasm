# Bun file descriptors and bounded reads

| Source | Class | Local change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/bun.js`, BunFile and write APIs | Host feature | Route numeric targets through descriptor operations, validate descriptor numbers, expose descriptor metadata and delegate range and stream reads. |
| `crates/bunwasm-runtime/src/js/bun_file.ts` and `bun_file_types.d.ts` | Host feature | Original typed adapter over existing open, close, fstat, read/pread and seek calls. |
| `crates/bunwasm-runtime/src/natives.rs`, descriptor bindings | Host feature | Expose absolute seeks through the existing libc descriptor used by reads and writes. |

These are original bun-wasm adapters, not copied Bun, Node or WebKit code. The
previous implementation is recorded at bun-wasm
`114b84c3a7b0f9c57df5e2daff5aa9d4d645ea3f`. Native Bun 1.4.4 is an executable API
reference, not an implementation source. No upstream patch or revision changes.

The adapter opens pathname streams on first demand, requests at most 64 KiB per
pull and reads explicit ranges without first loading the backing file. Slice
indexes truncate toward zero and NaN becomes zero before deriving read bounds,
preserving the previous typed-array range coercion. EOF,
cancellation and read errors close only descriptors the adapter opened. Borrowed
regular-file streams use pread, leaving the caller's offset intact. Unsliced
descriptor text/byte reads consume the caller's current offset. A sliced text/byte
read with a nonzero start seeks the borrowed descriptor and consumes the selected
range; a zero start instead consumes from the current offset. Numeric writes use
the current offset without truncating or closing the descriptor. Unsliced pathname
text/byte reads retain their existing whole-file operation.

The source control executes the production BunFile/Blob methods and erased typed
reader against real temporary files, with read sizes and offsets recorded. It
also exercises the production stream polyfill. The native fixture covers the
public API on supported guests; it does not measure Waffle's persistent-backend
I/O. Waffle owns cold-read hydration and descriptor mechanics.

## Descriptor cursor behavior

Native Bun 1.4.4 and the adapter now agree on these cases after the caller reads
two bytes from a descriptor for `abcdef`:

| Operation | Text / next two descriptor bytes |
| --- | --- |
| Unsliced text | `cdef` / empty |
| Slice 1..3 text | `bc` / `de` |
| Slice 1..3 stream | `bc` / `cd` |
| Slice 0..3 text | `cde` / `f` |

The source controls check the returned bytes, subsequent caller read, native calls
and borrowed descriptor lifetime. The public fixture runs the same cases on
supported guests. The native binding calls `lseek` on the existing descriptor; it
adds no cursor table, read/discard emulation or descriptor ownership change.
Waffle's existing `fd_seek` import provides the browser operation. Cold-read
hydration remains independent.

[Ledger scope and pinned revisions](scope.md).

Byte-stream EOF also completes pending BYOB requests. BYOB source controls run
against both stream implementations because the original Blob stream already
exposes a byte source; native Bun's file stream does not expose that reader mode.
The unsliced stdin text/byte path retains the existing `readStdin` binding.
