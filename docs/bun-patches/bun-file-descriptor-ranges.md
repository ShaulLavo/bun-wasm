# Bun file descriptors and bounded reads

| Source | Class | Local change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/bun.js`, BunFile and write APIs | Host feature | Route numeric targets through descriptor operations, validate descriptor numbers, expose descriptor metadata and delegate range and stream reads. |
| `crates/bunwasm-runtime/src/js/bun_file.ts` and `bun_file_types.d.ts` | Host feature | Original typed adapter over existing open, close, fstat and read/pread calls. |

These are original bun-wasm adapters, not copied Bun, Node or WebKit code. The
previous implementation is recorded at bun-wasm
`114b84c3a7b0f9c57df5e2daff5aa9d4d645ea3f`. Native Bun 1.4.4 is an executable API
reference, not an implementation source. No upstream patch or revision changes.

The adapter opens pathname streams on first demand, requests at most 64 KiB per
pull and reads explicit ranges without first loading the backing file. Path opens
use the shared native binding's numeric read-only flag, matching `node:fs`. Slice
indexes truncate toward zero and NaN becomes zero before deriving read bounds,
preserving the previous typed-array range coercion. EOF,
cancellation and read errors close only descriptors the adapter opened. Borrowed
regular-file streams and ranges use pread, leaving the caller's offset intact.
Unsliced descriptor text/byte reads consume the caller's current offset. Numeric
writes use the current offset without truncating or closing the descriptor.
Unsliced pathname text/byte reads retain their existing whole-file operation.

The source control executes the production BunFile/Blob methods and erased typed
reader against real temporary files, with read sizes and offsets recorded. It
also exercises the production stream polyfill. The native fixture covers the
public API on supported guests; it does not measure Waffle's persistent-backend
I/O. Waffle owns cold-read hydration and descriptor mechanics.

## Issue 195 remains open

A bounded follow-up on native Bun 1.4.4 confirmed these differences after a
caller reads two bytes from a descriptor for `abcdef`:

| Operation | Native text / next two descriptor bytes | Adapter text / next two descriptor bytes |
| --- | --- | --- |
| Unsliced text | `cdef` / empty | `cdef` / empty |
| Slice 1..3 text | `bc` / `de` | `bc` / `cd` |
| Slice 1..3 stream | `bc` / `cd` | `bc` / `cd` |
| Slice 0..3 text | `cde` / `f` | `abc` / `cd` |

The sliced-text source control checks the adapter's positional-read policy, not
native cursor parity. The public fixture does not assert these known divergent
text cases. Numeric routing is repaired, but #195 cannot close on this evidence.

The native bridge exposes sequential read and pread, but no seek operation.
Finishing native parity needs a coordinated shared seek binding plus the Bun
text-slice rules for zero and nonzero starts. Reading and discarding bytes,
reopening a borrowed descriptor, or maintaining a Bun-local cursor table would
not preserve descriptor identity and lifetime. None is added here. Waffle's
cold-read hydration work is independent of this gap.

[Ledger scope and pinned revisions](scope.md).

Byte-stream EOF also completes pending BYOB requests. BYOB source controls run
against both stream implementations because the original Blob stream already
exposes a byte source; native Bun's file stream does not expose that reader mode.
The unsliced stdin text/byte path retains the existing `readStdin` binding.
