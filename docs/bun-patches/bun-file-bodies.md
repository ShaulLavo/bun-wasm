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
  `Bun.serve` (`http_response.ts`) sends such a body with the file's size as the
  Content-Length and streams the bytes as they are read, so a large file is never held whole;
  HEAD sends the size alone. `fetch()` uploads a Bun.file() with a Content-Length.
- `Bun.file().stream()` remembers the file behind the stream. A body made from that stream
  keeps the file too: `blob()` gives the file's type, `clone()` gives both bodies the file
  (the given stream ends locked) instead of teeing it, and `Bun.serve` sends the file's type
  and size. `fetch()` uploads it chunked, as a stream, as native Bun does. Neither a Request
  nor a Response gets a Content-Type header from it.
- A file given by descriptor (`Bun.stdin`, `Bun.file(fd)`) can be read only once, so a clone
  tees a stream over it, as Bun does: both bodies read it as it arrives, and a pipe that never
  ends is never read whole. A stream over a descriptor is not lifted back to the file.
- Under `bun --hot`, `dev_html.ts` reads a Bun.file() HTML body (the usual
  `new Response(Bun.file("index.html"))`) within its 256 KiB limit to inject the dev client,
  without using the response.
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

## Differences left

Checked against native Bun 1.4.4 and not fixed here:

- `blob()` on a body over a missing file: Bun resolves with a Blob over the same file
  (size 0, `application/octet-stream`); here it reads the file and rejects with `ENOENT`.
- `text()` on a body held in memory whose `.body` a reader has locked rejects with
  `ERR_INVALID_STATE` "Invalid state: ReadableStream is locked"; Bun says
  `ERR_BODY_ALREADY_USED` "Body already used". Stream bodies already match Bun.
- `Bun.serve` answers HEAD over a Bun.file() with the file's Content-Type; Bun sends only the
  Content-Length.
- `Bun.serve` answers a sliced Bun.file() with 200 and the slice's length; Bun answers 206
  Partial Content with `content-range: bytes <start>-<end>/*` when the Response has no init
  headers or sets Content-Range itself.
- A JSON parse error over a UTF-16 body has the engine's own SyntaxError message; the decoded
  text matches Bun.

Fixed with this record: a Blob or File type that is not a string is ignored (Bun gives `""`), a
Bun.file() name set to `null` reads back `null`, and "Body already used" carries
`ERR_BODY_ALREADY_USED`.

The `bun-file-bodies` fixture compares this with native Bun.
