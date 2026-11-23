# fs argument forms and validation

Class **Host feature**, **adapted implementation** in
`crates/bunwasm-runtime/src/js/node_fs.js` and `fs_stream_constructors.ts`. The argument
handling follows Bun's `src/js/node/fs.ts` (`read`, `write`, `writeSync`, `exists`,
`close`, `truncate`, `defineCustomPromisifyArgs`, `get promises()`) and the native checks
in `src/runtime/node/node_fs.rs` (`Read::from_js`) at pinned revision
`9510e74152073d850a18758ca41114d8f214ffa6`, rewritten for bun-wasm's synchronous natives.
No code is copied. Native comparisons use Bun 1.4.4.

- `fs.read(fd, callback)` reads into a fresh 16 KiB Buffer, and `fs.read(fd, options,
  callback)` takes `buffer`, `offset`, `length` and `position` from an options object; a
  non-object options value is `ERR_INVALID_ARG_TYPE`.
- Reads check the buffer's type, then the offset as Node's `validateInteger(offset,
  "offset", 0)` does (`It must be an integer`, `It must be >= 0 && <= 9007199254740991`),
  then the length against the view, against what follows the offset and for its sign, in
  Bun's order and with Bun's messages.
- `writeSync` and `fs.write` with a view accept an options object in the offset slot and
  check the offset against the view's byte length whether or not a length follows (`It
  must be <= 5`), then the length (`It must be >= 0 and <= 3`). An offset equal to the
  byte length writes nothing. A buffer that is neither a string nor a view is
  `ERR_INVALID_ARG_TYPE` before the encoding is read. A string's encoding is the argument
  after the position, and `"buffer"` writes UTF-8. These errors throw synchronously from
  the callback form and reject from `FileHandle#write`.
- `util.promisify` resolves `read` and `readv` with `{ bytesRead, buffer(s) }` and
  `write` and `writev` with `{ bytesWritten, buffer(s) }` (the runtime's
  `nodejs.util.promisify.customArgs` symbol), and `fs.exists` with a boolean through
  `util.promisify.custom`. `fs.exists` without a callback is `ERR_INVALID_ARG_TYPE`.
- `fs.close(fd)` without a callback closes on a later turn.
- `truncate`, `truncateSync`, `ftruncateSync` and the promise form take a missing length
  as 0 and reject anything that is not a number (`The "len" argument must be of type
  number`); `truncate(fd, ...)` truncates the descriptor.
- `chmod`, `lchmod` and `fchmod` validate the mode with Node's `parseFileMode` (a boxed
  String is `ERR_INVALID_ARG_TYPE`). On WASI, `chmod` and `fchmod` record the lower 12
  permission bits (`0o7777`) into the runtime's per-process `(dev, ino)` mode table (see
  `docs/bun-patches/filesystem-options.md` for what records, clears, and bypasses it).
- `mkdir` rejects a `recursive` option that is not a boolean with Bun's message (`The
  "recursive" property must be of type boolean, got string`).
- `fs.cp` without a callback names the `cb` argument, as Bun does.
- `new ReadStream(path, fn)` and `new WriteStream(path, fn)` treat a function in the
  options slot as no options, as Node's `getOptions` does.
- Every function exported by `node:fs` is named after its key, and `fs.promises` is an
  enumerable getter that returns `node:fs/promises`.

The `fs-argument-forms` fixture compares these with native Bun 1.4.4 on QuickJS, JSC and
the Browser engine.
