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
pull and reads explicit ranges without first loading the backing file. EOF,
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

Native Bun has additional descriptor slice-text cursor behavior, including seeking
on nonzero slice starts. This adapter deliberately uses the available positional
read operation for bounded borrowed-descriptor ranges. It does not add a private
seek implementation or claim complete BunFile slice compatibility.

[Ledger scope and pinned revisions](scope.md).

Byte-stream EOF also completes pending BYOB requests. BYOB source controls run
against both stream implementations because the original Blob stream already
exposes a byte source; native Bun's file stream does not expose that reader mode.
The unsliced stdin text/byte path retains the existing `readStdin` binding.
