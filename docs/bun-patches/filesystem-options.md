# Filesystem flags, bigint stats and copy options

Class **Host feature**. These are original Bun/Node API adapters. No upstream implementation is copied or adapted.

`crates/bunwasm-runtime/src/js/fs_options.ts` implements the public string-to-numeric open flag mapping, numeric and bigint Stats objects, and synchronous/asynchronous copy filtering. `node_fs.js` forwards flags, stat options and FileHandle options to the native bindings. The options module follows bootstrap's factory contract: initialization returns the helper factory, and `node_fs.js` supplies its native bindings and path resolver to that helper. Copy traversal lives beside the JavaScript filter because filters can be asynchronous. It delegates metadata, directories and byte copying to the existing native filesystem operations. Accepted file copies create missing destination parents recursively before copying bytes. Existing parents go directly to byte copying, retaining `ENOTDIR` when the parent is a regular file. Only a parent stat failure with `ENOENT` triggers directory creation. Other stat and mkdir errors propagate unchanged. False or rejected filters leave missing destination parents untouched.

The filesystem regions of `crates/bunwasm-runtime/src/natives.rs` translate public Node flag bits to the target libc constants without adding create or truncate. The existing `writeFile` convenience binding remains for BunFile's append boolean; Node's `writeFileFlags` binding carries the full caller flags. Both call the same write helper. Exclusive copies open destinations with `create_new`, so checking and creating cannot race. On Unix they use the source permissions at creation and restore those permissions after copying, matching the existing standard-library copy path. WASI retains the standard-library limitation that POSIX permission copying is unavailable. No-overwrite copy skips do not suppress file-to-directory type errors. File creation defaults remain `0666` before the host applies its umask, including the existing BunFile convenience binding.

Native Unix opens pass `O_SYNC` and `O_DSYNC` to the OS. WASI retains those modes in the runtime's owned-descriptor table instead of passing Preview1 sync fdflags, which the pinned Wasmtime rejects at open. Every successful one-shot, scalar or vectored write then issues the corresponding `fd_sync` or `fd_datasync` barrier before returning; closing removes the retained mode. Waffle already provides both barriers, so this uses the existing OS/runtime boundary rather than adding a second filesystem adapter.

Bigint stat calls serialize integer metadata with `Val::BigUint` before any float conversion. Timestamp nanoseconds and integer milliseconds use decimal strings across the engine-neutral boundary, then the Stats constructor turns them into BigInts. This also represents negative timestamps and timestamps outside a 64-bit nanosecond range. Dates convert milliseconds to numbers only for the Date API. Normal Stats retain numeric fields and omit nanoseconds. Each path stat serializes one metadata snapshot: Unix uses `std::fs::Metadata` and its metadata extensions; WASI uses one libc `stat` or `lstat` result. Descriptor serialization likewise takes fields from one snapshot and retains the existing process-host FIFO mode correction. WASI has no birth timestamp, so it remains zero rather than being inferred from another filesystem call.

`src/natives/wasi_metadata.rs` is an original metadata adapter. Preview1 reports
file types without POSIX permission bits. WASI Stats therefore present `0644`
for files and special descriptors, `0755` for directories, and `0777` for
symlinks, retaining the reported type. The same mapping reaches numeric and
bigint path, link, and descriptor Stats. Unix Stats keep the real host mode.
These presentation bits do not grant rights or change open, read, or write
enforcement. Without a read bit, chokidar rejects existing readable config files
during directory scans and reports them removed. The standalone native test
exercises the production mapping without building an engine or guest.
The `fs-stat-presentation` guest fixture checks readable file, directory, link,
descriptor, and bigint Stats through the public filesystem APIs.

The reference contracts are Node's `lib/fs.js`, `lib/internal/fs/utils.js` and `lib/internal/fs/cp/{cp,cp-sync}.js` at Node v24.22.1, and Bun 1.4.4's public filesystem APIs, observed as executable controls rather than copied source. Supplied reproductions audited bun-wasm `72d1394484dcd64b051f63f230ad70bfaf2769ae`; this change starts at `114b84c3a7b0f9c57df5e2daff5aa9d4d645ea3f`.

Waffle at `b20fad173ebaa225cb87c51776f35edaaafd4a40` already supplies create, exclusive, truncate and append semantics. NONBLOCK support remains Waffle #111; unsupported open bits fail explicitly here. Link-count accuracy remains Waffle #115. Cold persistent-file hydration remains Waffle #112. Bigint representation does not repair incorrect underlying metadata. This change does not implement those capabilities in the consumer.
