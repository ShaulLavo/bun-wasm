# FileHandle streams, mkdtemp and the uv binding

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/fs_file_handle.ts` | Port | `FileHandle` from Bun's `src/js/node/fs.promises.ts`: EventEmitter base, reference counting and deferred `close()`, `readableWebStream`, `createReadStream`, `createWriteStream`, `pull`, `pullSync` and `writer`, over the synchronous fs natives. |
| `crates/bunwasm-runtime/src/js/fs_stream_constructors.ts` | Port | `options.fd` may be a FileHandle, as in Bun's `src/js/internal/fs/streams.ts` (`fileHandleStreamFs`, `streamFileHandleClose`). |
| `crates/bunwasm-runtime/src/js/node_fs.js` | Original adapter | `mkdtemp` encoding option, empty prefix and error shape; FileHandle arguments to `promises.readFile`, `writeFile` and `appendFile`; lazy FileHandle module. |
| `crates/bunwasm-runtime/src/js/uv_errors.ts` | Original adapter | libuv's error table for `process.binding("uv")` and fs error messages. |
| `crates/bunwasm-runtime/src/js/process.ts` | Original adapter | `process.binding("uv")`. |

Upstream revision: Bun `9510e74152073d850a18758ca41114d8f214ffa6`. Behaviour was
compared with native Bun 1.4.4. No upstream file is patched.

## FileHandle

The port keeps Bun's structure and messages: a closed handle reports a `SystemError`
"Bad file descriptor" with Bun's syscall names, the iterable and web stream methods
report `ERR_INVALID_STATE` for a closed, closing or locked handle, and `close()` while a
stream, web stream, pull source or writer holds a reference waits for the last
reference. The local changes:

- Operations call the synchronous natives directly, so ordinary methods take no
  reference. Writer writes and `pull` reads run on a later turn, where Bun's run on
  its threadpool, so `end()` and `fail()` still defer teardown past writes in flight.
- Bun's private symbols become module symbols; `kFd`, `kRefs` and the close promise
  become private fields.
- `pull` and `pullSync` take options but no transforms. Transforms need Node's iterable
  streams pipeline (`internal/streams/iter/pull`), which this runtime does not have;
  passing one throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
- A `FinalizationRegistry` closes leaked handles on garbage collection and schedules
  Bun's `ERR_INVALID_STATE` diagnostic (including the descriptor and snapshotted path) on
  a later turn. Explicit `close()`, deferred last-ref `[kUnref]()`, and `[kCloseSync]()`
  disarm and unregister the handle before closing its descriptor so a reused fd is never
  closed by an old handle's finalizer.
- Validators are local functions with Node's messages.

## mkdtemp

An empty prefix throws `EINVAL` with Bun's message and template path `XXXXX`. A missing
parent reports the native error code with syscall `mkdtemp` and the generated path,
in Bun's key order. Creation retries on `EEXIST` instead of checking existence first.
The `encoding` option re-encodes the UTF-8 path or returns a Buffer.

## uv binding

`process.binding("uv")` returns one cached object: `errname`, a `UV_` constant for each
libuv error in Bun's order, and `getErrorMap`, which returns a new map on each call.
`errname` does not validate its argument, as in Bun.

The fixtures `tests/fixtures/fs-mkdtemp` and `tests/fixtures/fs-file-handle-streams`
cover these against native Bun output on QuickJS, JavaScriptCore and the browser engine.
