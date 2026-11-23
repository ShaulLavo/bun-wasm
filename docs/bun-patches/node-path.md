### Node path

`vendor/bun/src/node_path/lib.rs`, Bun upstream revision
`9510e74152073d850a18758ca41114d8f214ffa6`. The path sources are unchanged in
the measured WASI checkout `5e0baa66516f3af00b008cdf1521c681317741e8`.
Class **Port**. The existing `bun_node_path` crate is a direct dependency, with no
source changes. Its Windows basename,
dirname, extname, isAbsolute, normalize, join, and parse algorithms run on
`u8` or `u16` slices. These are the same algorithms Bun's runtime and toolchain use.
The previous partial Node POSIX implementation in `src/js/path.js` is removed.

### POSIX operations in JavaScript

`crates/bunwasm-runtime/src/js/path.ts` ports Bun's POSIX `basename`, `dirname`,
`extname`, `isAbsolute`, `normalize` (with its private `normalize_string_t`),
`join`, `parse` and the resolved part of `relative` from the same
`vendor/bun/src/node_path/lib.rs` to TypeScript. Class **Port**. Bun's functions
are themselves translated from Node's `lib/path.js` at
`6ae20aa63de78294b18d5015481485b7cd8fbb60` (v21.6.1, MIT), whose JavaScript
shape the port follows. They are lexical, so they now run on the string's UTF-16
code units without crossing into Wasm; only `process.cwd()` is read for a
relative resolve. Before, each call crossed the JavaScript to Wasm boundary once
or more (10,000 mixed calls took 38 to 101 ms across engines, against 1.6 ms in
native Bun). Local changes:

- Bun's optional indices become Node's `-1` sentinels, and `basename` with a
  suffix is a separate function.
- `extname` and `parse` share one scan of the last component. It keeps Bun's
  rule that a dot after a non-dot character leaves the pre-dot state at "seen a
  non-dot" (Node resets it to "only dots"); the two never differ in results.
- `normalize` returns a path unchanged when it has no `//`, no leading `.` and
  no `/.`, because then no segment is empty, `.` or `..`. Otherwise it runs the
  full segment walk.
- Validation, boxed-string coercion and the right-to-left POSIX `resolve` stay
  the adapter's own code below, unchanged.
- The POSIX code calls `charCodeAt`, `slice`, `indexOf` and `lastIndexOf`
  through intrinsics that `src/js/bootstrap.js` captures before user code
  runs, and builds no ordinary arrays: `normalize` keeps its segment stack as
  offsets in a reused `Int32Array`, which stays linear for long runs of `..`
  and has no inherited index accessors, and `join` and `resolve` validate their
  arguments while they walk them. Replacing a public `String.prototype` or
  `Array.prototype` method, or adding inherited index accessors, therefore
  cannot change a result, as with the native code it replaces. The Windows
  wrappers keep their previous code exactly.
- A replaced `process.cwd` that returns a non-string keeps the previous
  adapter's handling: a falsy value is skipped, and other values get the same
  `startsWith` and `slice` calls, so a number still throws `TypeError`.
- `relative` keeps the native string route's one error: with a relative guest
  cwd, the fixed one-unit offset can split a surrogate pair, and when both
  resolved paths are well-formed Bun rejected that result with
  `Error: Path string result contains an unpaired surrogate`.

The native binding no longer has POSIX arms: its calls drop the platform flag,
and `scripts/generate-node-path.ts` extracts only the Windows relative
computation. `scripts/node-path-posix.test.ts` loads `path.ts` with a native
binding that throws and compares about 39,000 results, from every sequence of
up to six path tokens and 40,000 sampled pairs, with the host Bun's native
`node:path`. It also checks the split-surrogate error recorded from the native
guest and that results survive replaced string, array and `Math` methods.
`tests/fixtures/node-path-prototypes` repeats the prototype check in every guest
engine, through the real bootstrap capture.

`crates/bunwasm-runtime/src/node_path.rs` and `src/js/path.ts` are **Host feature**
original adapters. For Windows operations, after public validation and coercion, the
`String.prototype.isWellFormed` intrinsic, captured before user code in
`src/js/bootstrap.js`, selects owned UTF-8 strings for
well-formed inputs. Except for join, Rust converts them with `encode_utf16` and
checks every output with `String::from_utf16`. If any
relevant input contains an unpaired surrogate, the entire call uses lossless
little-endian UTF-16 buffers. Neither route normalizes Unicode or drops BOM/NUL
code units. Both routes return owned data through the existing native transport.
Windows resolution keeps its UTF-16 route. POSIX resolution scans right to left
for an absolute path before one normalization, without per-argument parse calls.
Well-formed `joinString` inputs instead borrow their UTF-8 bytes and instantiate
the same unmodified generic join algorithms with `u8`. These algorithms recognize
ASCII separators and dot segments and copy other bytes intact. The adapter checks
the returned UTF-8 before creating an owned string. This removes each input's
UTF-16 allocation and conversion, the outer owned-path vector, and the result's
UTF-16 conversion. Calls containing lone surrogates keep the existing `u16` route.
The adapter implements POSIX resolve, relative, format, namespace
conversion, and `_makeLong` over the lexical operations and guest
`process.cwd()`. Bun's native resolve and relative functions read a process-wide
filesystem singleton, so calling them directly would use the toolchain's cwd
instead of the current guest cwd. The adapter does not initialize or change
that shared state.

`scripts/generate-node-path.ts` extracts Bun's Windows resolver, tail normalizer,
and six private helpers from the same upstream file. Class **Port**. It replaces the
two cwd reads with a supplied guest cwd slice and specializes the tail normalizer
to Windows. Bun's device selection, separator handling, tail normalization and
output writes remain unchanged. The generated upstream functions retain their
original control flow. Dependency imports come through the authored adapter so
Cargo dependency analysis sees the crates used by generated source. The original
host adapter passes validated UTF-16 paths
and the current guest cwd to this resolver. It replaces the previous handwritten
Windows resolution algorithm, which could create a false UNC root by joining
cwd `/` and a relative tail before normalization.

The generator also extracts the Windows relative function's computation after its
resolution preamble. It specializes `T` to `u16` and accepts resolved input slices
instead of reading cwd. Bun's comparisons, separator scans, UNC rules, and output
writes remain unchanged. The generator rejects an unexpected source shape or
residual cwd dependency. Argument traversal and suffix-before-path validation adapt
`src/runtime/node/path.rs` at the same revision. POSIX resolution stops checking
arguments at an absolute path; Windows resolution validates every argument.
`matchesGlob` uses the existing Bun glob native and normalizes
Windows separators, matching `src/js/node/path.ts` at the same revision.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`vendor/bun/src/node_path/lib.rs`](#node-path) | Port | Run Bun's unmodified Windows path algorithms over UTF-8 or UTF-16 slices. |
| [`crates/bunwasm-runtime/src/js/path.ts` POSIX operations](#posix-operations-in-javascript) | Port | Bun's POSIX path algorithms (after Node's `lib/path.js`) in TypeScript, without Wasm crossings. |
| [`scripts/generate-node-path.ts`](#node-path) | Port | Extract Bun's Windows relative-path computation with guest-resolved paths supplied by the adapter. |
| [`vendor/bun/src/runtime/node/path.rs`](#node-path) | Port | Adapt the public path argument traversal and validation order to the JavaScript boundary. |
| [`crates/bunwasm-runtime/src/js/path.ts`](#node-path) and `src/node_path.rs` | Host feature | Original adapters for JavaScript validation, guest cwd, and lossless UTF-16 transport. |

`tests/fixtures/node-path-transport` records 10,958 path results, object fields,
errors and coercion/cwd observations in both namespaces. Its oracle comes from
the unchanged adapter at `b351c86d7576a2411f6d7a46d1fec9d8da60485b`.
Run with `--snapshot --record` to emit complete results for a byte comparison;
ordinary runs assert their SHA-256. Coverage includes malformed surrogates,
suffix boundaries, BOM/NUL, long paths and allocation-heavy repeated calls.
`node-path-intrinsic` replaces the public intrinsic in eval before requiring
`node:path`, checking that the bootstrap capture remains trusted.
`node-path-utf8-join` checks UTF-8 width boundaries, supplementary characters,
combining marks, BOM/NUL, long inputs, Windows roots, and mixed lone surrogates.

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
