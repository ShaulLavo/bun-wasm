# Bun.file() bodies and copied Request bodies

Class **Runtime behavior**, **original adapters** in `crates/bunwasm-runtime/src/js/web.js`,
`body_streams.ts`, `bun.js`, `http_response.ts` and `fetch_lifetime.ts`. No upstream code is
copied. The behavioral reference is Bun at revision
`9510e74152073d850a18758ca41114d8f214ffa6` (`test/js/web/fetch/body-clone.test.ts`, "clone()
of a body over an unread native stream keeps the Blob behind it", and "new Request(src,
init) with a user ReadableStream body"), checked against native Bun 1.4.4.

- A Request or Response made from a Bun.file() (or a Blob over one) keeps the file in
  `_blob` instead of reading it at construction. It is read when the body is used, so a
  body over a missing file or a directory can be made and cloned, and each read then fails
  on its own; a clone, a later `.body` and `Bun.inspect` see the file as it is then.
  `Bun.inspect` prints the file's current size, and no size when it cannot be stat'ed.
  `Bun.serve` sends such a body whole, with a Content-Length.
- `Bun.file().stream()` remembers the file behind the stream. A body made from that stream
  keeps the file too: `blob()` gives the file's type, `clone()` gives both bodies the file
  (the given stream ends locked) instead of teeing it, `Bun.serve` sends the file's type, and
  `fetch()` uploads it with a Content-Length. Neither a Request nor a Response gets a
  Content-Type header from it.
- `new Request(request, init)` copies the source's body the way `clone()` does, so the
  source keeps its own body (Bun tees it). A used stream body copies as a used body, a used
  body that was in memory copies as empty bytes, and only a stream someone else holds
  throws. `fetch(request, init)` without its own body still sends the request's body and
  leaves it used, as Bun does. The `runtime-request-copy` contract asserted the opposite
  (the source used after a copy), which native Bun 1.4.4 fails; it now checks Bun's
  behavior, and native Bun passes it.
- `new Request(url, response)` takes the Response's headers and a copy of its body, with any
  method, as Bun does.
- Reading a directory through Bun.file() fails with Bun's `EISDIR` "Directories cannot be
  read like files" (`syscall: "read"`), where WASI's open gives `EBADF`.

`Bun.file()` of a FIFO (`mkfifo`) and procfs files are host limits: WASI has neither.

The `bun-file-bodies` fixture compares this with native Bun.
