## Compression and archive adapters

Class **Port**, `crates/bunwasm-runtime/src/js/zlib.ts`. node:zlib follows Node's
`lib/zlib.js` (Node v26.7.0; Bun's `src/js/node/zlib.ts` at upstream
`9510e74152073d850a18758ca41114d8f214ffa6` is the same code over `$rust` handles):
`ZlibBase`, `processChunk`, `processCallback`, `processChunkSync`, the flush
buffers and `maxFlush`, `params`, the option validators and the Brotli and Zstd
parameter tables. Local changes: TypeScript classes instead of prototype
functions, a JavaScript `Handle` object in place of the C++ binding that calls
the native context once per write (`setImmediate` stands in for the thread
pool), and the sync convenience functions call the same loop in Rust
(`zlibConvert`) instead of building a stream, unless `info` asks for the engine.
The Brotli and Zstd constants are Bun's `ProcessBindingConstants.cpp` values.

Class **Port**, `crates/bunwasm-runtime/src/compression.rs`. `Handle` ports the
per-write logic of Bun's `src/runtime/node/zlib/Native{Zlib,Brotli,Zstd}.rs`
(Node's `node_zlib.cc`) at the same revision: one codec call per write into a
caller-sized buffer, gzip member and UNZIP detection, dictionary loading, and
Node's error messages, codes and errnos. Local change: Node's `unexpected end of
file` (`Z_BUF_ERROR`) for an unfinished Zstd frame at `ZSTD_e_end`, which Bun
omits (it returns empty output). `WebCoder` ports
`src/runtime/webcore/CompressionStreamCoder.rs`: steps bounded by
`max(highWaterMark, chunk length)`, trailing-junk and Zstd frame checks, and the
error mapping. Its off-thread path and native sink delivery are not ported. The
contexts call Bun's unchanged FFI declarations in `vendor/bun/src/zstd/lib.rs` and
`vendor/bun/src/brotli_sys/`, and zlib through the original declarations in
`src/zlib_ffi.rs`. Output bytes therefore match Bun's; Node's Chromium zlib differs
from both on larger inputs and after full flushes, while headers, flush markers and
small-input bytes match all three (tests/fixtures/compression-review).

Class **Port**, `third_party/zlib-ng/`: zlib-ng 2.3.3 (`ZLIBNG_VERSION`), the
release Bun pins in `scripts/build/deps/zlib.ts` (tag commit
`12731092979c6d07f42da27da673a9f6c7b13586`), copied from the copy bundled in the
`libz-sys` 1.1.25 crate. Only the portable C
sources, `arch/generic/`, the header templates and `LICENSE.md` are kept; gzip file
I/O, the one-shot `compress`/`uncompress` files (bunwasm-glue already exports a
`compress2`), CMake files and the SIMD kernels are omitted, and no file is modified. The
original `build.rs` adapter writes `zlib.h` and `zconf.h` from their templates with
Bun's substitutions and compiles them with Bun's defines plus `WITH_ALL_FALLBACKS`
(the portable kernels), since wasm has no SIMD dispatch.

Class **Port**, `third_party/brotli/c/` and `LICENSE`: Google Brotli 1.2.0 at
`028fb5a23661f123017c060daa546b55cf4bde29`, the revision in Bun's
`scripts/build/deps/brotli.ts`, unchanged except that `c/tools/` (the command-line
tool) is omitted. The original `build.rs` adapter compiles `common`, `dec` and `enc`
with `BROTLI_BUILD_PORTABLE`. The Rust `brotli` crate, the runtime's `miniz_oxide`
helpers and the crates.io `zstd` encoder are no longer runtime codecs.

Class **Host feature**, original adapters: `src/js/compression_streams.ts` drives
`WebCoder` the way Bun's `JSCompressionStreamShared.cpp` does (readable
high-water mark 1, a write settles once its expansion is read, cancel and abort
settle a parked step, an abort during close keeps the flush) and parses Bun's
`level` and queuing-strategy options; the `Bun.gzipSync` family and
`Bun.zstd*` wrappers in `bun.js`, `zlib.ts` and `natives.rs` call the same
contexts and Bun's own `bun_zstd::compress_append`/`decompress_alloc`;
`src/streams.rs` keeps the handle registry. `src/js/archive.ts` and
`src/archive.rs` are original: gzip tar input is decoded as the tar parser reads
it, `files()` reads each entry in 64 KiB fallible steps like Bun's
`Archive.rs`, and extraction streams entries to disk with the tar crate's
`Entry::unpack_in`. Expansion is bounded by Node's `maxOutputLength` for the
convenience functions, by read demand for streams, and by available memory
(a catchable out-of-memory error) for Bun's functions and `files()`, as in Bun.

Native fetch decodes Zstd HTTP bodies with the same `zstd-sys` library. The Node
host forwards raw Zstd bodies through the fetch head's `bodyEncoding` field to the
guest's DecompressionStream, because Node 26.7.0's decoders stop after the first
concatenated frame. A head without the field (browser HTTP, which uses its own
content decoder, and the runtime's virtual loopback) is exposed as-is.
Archives reuse `tar` 0.4.46 with default features disabled and the
[WASI extraction port](tar-wasi-extraction.md#tar-wasi-extraction). Other libarchive formats are not added.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Compression and archive adapters](#compression-and-archive-adapters) | Host feature | Original Web stream driver, Bun function wrappers, archive reader and native handle registry. |
| [`src/js/zlib.ts`, Node zlib streams](#compression-and-archive-adapters) | Port | Node's `lib/zlib.js` stream, flush, limit and validation logic over the native handle. |
| [`src/compression.rs`, native codec contexts](#compression-and-archive-adapters) | Port | Bun's native zlib, Brotli and Zstd handle calls and its Web stream coder steps. |
| [`third_party/brotli/`](#compression-and-archive-adapters) | Port | Google Brotli 1.2.0 C source at Bun's pinned revision, built by `build.rs`. |
| [`third_party/zlib-ng/`](#compression-and-archive-adapters) | Port | zlib-ng 2.3.3 portable C source, Bun's pinned zlib, built by `build.rs`. |
| [Compression constants](#compression-and-archive-adapters) | Port | Public Brotli and Zstd constant names and integer values for the Node adapter. |

[Ledger scope and pinned revisions](scope.md).
