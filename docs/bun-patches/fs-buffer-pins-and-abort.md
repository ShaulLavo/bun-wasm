# Filesystem buffer pins, AbortSignal and iterable writeFile

Class **Host feature**. Two modules: `crates/bunwasm-runtime/src/js/fs_buffer_pins.ts`
is an **original adapter**; `crates/bunwasm-runtime/src/js/fs_abortable.ts` is an
**adapted implementation** of part of Bun's `src/js/node/fs.promises.ts` at pinned
revision `9510e74152073d850a18758ca41114d8f214ffa6`. `node_fs.js` loads each one
the first time a call needs it. Native comparisons use Bun 1.4.4.

## Buffer pins

Bun pins the bytes an fs call reads until the call completes: the data of `write`,
`writev`, `writeFile` and `appendFile`, and a path given as bytes
(`PinnedArrayBuffer` in `src/runtime/node/types.rs`). JavaScriptCore cannot detach
a pinned ArrayBuffer: `ArrayBuffer::transferTo` in
`Source/JavaScriptCore/runtime/ArrayBuffer.cpp` copies a non-detachable buffer
instead, so `transfer()` and `transferToFixedLength()` return a copy and the
original stays attached. QuickJS, the JSC guest and the browser host engine have
no such pins, so `fs_buffer_pins.ts` counts pins per ArrayBuffer in a WeakMap
and replaces those two prototype methods. A pinned buffer gets a copy; any other
buffer reaches the original method. JavaScript has no way to make a buffer
non-detachable, so the methods must be replaced; each replacement is a `Proxy`
over the engine's own method rather than a new function, so
`Function.prototype.toString` still prints it as native code, `[native code]`
feature checks (core-js, the bundled Temporal polyfill) keep their answer, and
`name`, `length` and the missing `prototype` stay the original's. A reference
to the original method captured before the first pin is a different object and
still detaches. A pinned buffer's BigInt length is a `TypeError`, as ToIndex
makes it. The callback and promise forms in
`node_fs.js` pin before they run the operation and release before they deliver
its result, so the buffer is detachable again by the time the callback or
promise reaction runs. The replacement methods are installed when the module
first loads, which is the first callback or promise fs call given bytes. A call
whose path and data hold no bytes allocates nothing for pins and runs the same
delivery closure as before. On QuickJS, 100,000 promise `readFile` and callback
`write` calls take about 2% more CPU than on main, the same difference a control
loop over unchanged code shows between the two builds.

Bun reads a byte path when the call starts (`PathLike::from_js` copies a
resizable buffer at once). `readFileSync`, `writeFileSync` and `mkdirSync` now
convert their path before reading options, so an option getter that resizes or
transfers the path's buffer cannot change the file used. Paths also accept a
`DataView` or an `ArrayBuffer` of path bytes, as Bun's `PathLike` does.

## AbortSignal and iterable writeFile

`readFile`, `writeFile` and `appendFile` (promise and callback forms) reject an
aborted `options.signal` with Node's AbortError: an `Error` named `AbortError`,
code `ABORT_ERR`, message `The operation was aborted` and `cause` set to
`signal.reason`. A pre-aborted signal performs no work. These operations finish
in one synchronous step here, so an abort that arrives before the result is
delivered replaces it, as an abort during Bun's in-flight read does.

`fs.promises.writeFile` of a sync or async iterable follows Bun's
`writeFileAsyncIterator`: it opens the path with the caller's flag and mode,
writes each chunk at the current offset (re-encoding strings for encodings
other than UTF-8, binary and buffer, rejecting `null` and `undefined` chunks),
truncates to the bytes written only for truncating flags (`w`, `w+`, `wx` and
their spellings), and closes the file. An abort checked before each chunk
replaces any other error. `FileHandle#writeFile` takes the same iterables and
writes them from the handle's position. Differences from Bun: chunks are written
with `writeSync` instead of a `FileSink`, a byte path is opened like a string
path, and a FileHandle target writes through its descriptor. Calls without a
signal or iterable data return the plain operation's promise; only the others
go through an async helper.

Known message differences, kept as they are: an `options.signal` that is not an
AbortSignal is a `TypeError` with code `ERR_INVALID_ARG_TYPE` whose message
differs from Bun's wording, and an invalid chunk's message names the types
Bun's `writeFileAsyncIterator` lists. The name, code, message and cause of the
AbortError itself match Bun.

The `fs-buffer-pins` and `fs-abort-signal` fixtures compare these behaviors with
native Bun 1.4.4. Run them with
`scripts/test.sh --engine quickjs fs-buffer-pins fs-abort-signal` (and `jsc`,
`browser`).
