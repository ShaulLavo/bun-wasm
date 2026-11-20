# Filesystem flags, bigint stats and copy options

Class **Host feature**. These are original Bun/Node API adapters. No upstream implementation is copied or adapted.

`crates/bunwasm-runtime/src/js/fs_options.ts` implements the public string-to-numeric open flag mapping, numeric and bigint Stats objects, and synchronous/asynchronous copy filtering. `node_fs.js` forwards flags, stat options and FileHandle options to the native bindings. The options module follows bootstrap's factory contract: initialization returns the helper factory, and `node_fs.js` supplies its native bindings and path resolver to that helper. Copy traversal lives beside the JavaScript filter because filters can be asynchronous. It delegates metadata, directories and byte copying to the existing native filesystem operations. Accepted file copies create missing destination parents recursively before copying bytes. Existing parents go directly to byte copying, retaining `ENOTDIR` when the parent is a regular file. Only a parent stat failure with `ENOENT` triggers directory creation. Other stat and mkdir errors propagate unchanged. False or rejected filters leave missing destination parents untouched.

The filesystem regions of `crates/bunwasm-runtime/src/natives.rs` translate public Node flag bits to the target libc constants without adding create or truncate. The existing `writeFile` convenience binding remains for BunFile's append boolean; Node's `writeFileFlags` binding carries the full caller flags. Both call the same write helper. Exclusive copies open destinations with `create_new`, so checking and creating cannot race. On Unix they use the source permissions at creation and restore those permissions after copying, matching the existing standard-library copy path. WASI retains the standard-library limitation that POSIX permission copying is unavailable. No-overwrite copy skips do not suppress file-to-directory type errors. File creation defaults remain `0666` before the host applies its umask, including the existing BunFile convenience binding.

Native Unix opens pass `O_SYNC` and `O_DSYNC` to the OS. WASI retains those modes in the runtime's owned-descriptor table instead of passing Preview1 sync fdflags, which the pinned Wasmtime rejects at open. Every successful one-shot, scalar or vectored write then issues the corresponding `fd_sync` or `fd_datasync` barrier before returning; closing removes the retained mode. Waffle already provides both barriers, so this uses the existing OS/runtime boundary rather than adding a second filesystem adapter.

Bigint stat calls serialize integer metadata with `Val::BigUint` before any float conversion. Timestamp nanoseconds and integer milliseconds use decimal strings across the engine-neutral boundary, then `makeStats` turns them into BigInts. This also represents negative timestamps and timestamps outside a 64-bit nanosecond range. Dates convert milliseconds to numbers only for the Date API. Normal Stats retain numeric fields and omit nanoseconds; their `*Ms` values add whole seconds times 1000 to the nanoseconds over a million, as Bun's `Stat.rs` `to_time_ms_f64` does, so a time stored as 1700000000.25 s reads 1700000000250 rather than the 1700000000249.9998 a single division of the nanosecond count gives. Each path stat serializes one metadata snapshot: Unix uses `std::fs::Metadata` and its metadata extensions; WASI uses one libc `stat` or `lstat` result. Descriptor serialization likewise takes fields from one snapshot and retains the existing process-host FIFO mode correction. WASI has no birth timestamp, so it remains zero rather than being inferred from another filesystem call.

`fs.Stats` and the `BigIntStats` prototype follow Bun's
`src/jsc/bindings/NodeFSStatBinding.cpp` at pinned revision
`9510e74152073d850a18758ca41114d8f214ffa6`, rebuilt in TypeScript (no C++ is
copied). `Stats(...)` works with or without `new`, takes Node's argument order
(`dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks, atimeMs, mtimeMs,
ctimeMs, birthtimeMs`) and lays fields out in Bun's order (`dev, ino, mode, nlink,
uid, gid, rdev, size, blksize, blocks`, then the times). The prototype holds
enumerable `is*` methods and `atime`, `mtime`, `ctime` and `birthtime` accessors.
An accessor builds a Date from the matching `*Ms` field and caches it as an own
property, so a later `*Ms` change does not move it; its setter stores the given
value. Methods and accessors return undefined for a receiver that is not an
object. `BigIntStats` has its own prototype (not a Stats subclass); its
constructor derives `*Ms` numbers from `*Ns` BigInts, and its date accessors
refuse number fields, as JSC's `toBigInt64` does. `statSync`, `lstatSync` and
`fstatSync` build their results through `makeStats` with the same prototypes and
order; `fstatSync` validates its descriptor first. The `fs-stats-constructor`
fixture compares these with native Bun 1.4.4.

`utimes`, `lutimes` and `futimes` (sync, callback and promise forms) convert
their times as Bun's `src/runtime/node/time_like.rs` does: a number of seconds
(a negative one means now), a Date (by its milliseconds) or a numeric string;
anything else, or a non-finite value, is a `TypeError` with code
`ERR_INVALID_ARG_TYPE`. `timeSpec` in `fs_options.ts` returns whole seconds and
nanoseconds with Rust's euclidean division. The original
`src/natives/file_times.rs` sets them with `utimensat` (with
`AT_SYMLINK_NOFOLLOW` for `lutimes`) or `futimens`, using `UTIME_NOW` for now.
Errors carry Node's operation names `utime`, `lutime` and `futime`. WASI Preview1
timestamps are unsigned nanoseconds since the epoch, so a time before 1970 is
`EINVAL` on both hosts; native Bun stores it. The Browser fixture host (Node's
WASI) stores only whole seconds when setting times, and Waffle sets only the
modification time, at millisecond precision. The `fs-utimes` fixture compares
whole-second times and errors with native Bun 1.4.4 on all three engines;
`fs-utimes-fractions` compares sub-second times on QuickJS and JSC.

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

The filesystem path resolver preserves an empty caller path instead of resolving
it to the working directory before the Rust native call. Rust's filesystem
bindings use the original `src/natives/fs_path.rs` guard and existing `io_error` conversion to reject empty required paths
before WASI can resolve them to a preopened directory. This covers `stat`,
`lstat` and related file operations, including fresh errors and deferred callback
and promise delivery. Existence checks return false, and forced removal of an
empty missing path remains a no-op. The guard applies to required filesystem
paths, not lexical path operations or temporary-directory prefixes.
The existing synchronous and callback `realpath` behavior still resolves an
empty path to the working directory, as Node v26.12.1 does. Empty `mkdtemp`
prefixes still acquire their random suffix before path resolution. The
`fs-empty-path` fixture and source-boundary check exercise these contracts; this
is an original adapter correction, with no copied upstream code.

The stat accessor-order and materialization-order source tests preserve both
`bigint` reads, the original catch, flag/code read order and eager Error
construction, including inherited property setters. The `fs-stat-missing`
guest fixture checks fresh errors, getter-thrown identity and deferred callback
and promise delivery. The direct split error writer is documented separately
in [Native error reply encoding](native-error-encoding.md); it changes no stat
option handling or JavaScript Error construction.

Open flags and file modes are validated as Node's `stringToFlags`, `validateInt32`
and `parseFileMode` (`lib/internal/fs/utils.js`, `lib/internal/validators.js`) do,
checked against native Bun 1.4.4: an unknown flag string reports the value through
`util.inspect` (`Received 'W'`), a numeric flag must be an int32 (`ERR_OUT_OF_RANGE`
otherwise), and a mode is an octal digit string or a uint32, with
`ERR_INVALID_ARG_VALUE`, `ERR_INVALID_ARG_TYPE` or `ERR_OUT_OF_RANGE`. `openSync`,
`mkdirSync` and `writeFileSync` validate their mode; WASI still applies none. The
callback forms throw these three argument-validation codes synchronously, as Node
validates before it queues the operation, while system errors still reach the
callback. `fs_options.ts` takes the inspector from `node_fs.js`, which loads it only
when an error message needs it. The `fs-flag-mode-validation` fixture covers these
cases.

`writeSync`, `fs.write` and `writevSync` treat only a non-negative safe integer as a
file position, as Node's `GetOffset` in `src/node_file.cc` does; NaN, ±Infinity,
fractions, numbers past `Number.MAX_SAFE_INTEGER`, negative numbers and BigInts
write at the current file offset instead of being truncated to a position. The
`fs-write-position` fixture compares buffer, string, vector and callback writes
with native Bun 1.4.4.

The `encoding` option of `readFile`, `writeFile`, `appendFile`, `readdir`,
`readlink`, `realpath` and `mkdtemp` (sync, callback and promise forms) is checked
by `encodingOf`: anything `Buffer.isEncoding` rejects, other than `"buffer"`,
throws `ERR_INVALID_ARG_VALUE` with native Bun 1.4.4's message
(`encoding 'test' is an invalid encoding`), synchronously for the callback forms.
`fs.ReadStream` and `fs.WriteStream` use Node's wording
(`The argument 'encoding' is invalid encoding. Received 'test'`). `"buffer"` reads
return a Buffer, and a string written with it becomes Latin-1 bytes, as in Bun.
The `fs-encoding-validation` fixture compares these with native Bun.

Waffle at `b20fad173ebaa225cb87c51776f35edaaafd4a40` already supplies create, exclusive, truncate and append semantics. NONBLOCK support remains Waffle #111; unsupported open bits fail explicitly here. Link-count accuracy remains Waffle #115. Cold persistent-file hydration remains Waffle #112. Bigint representation does not repair incorrect underlying metadata. This change does not implement those capabilities in the consumer.
