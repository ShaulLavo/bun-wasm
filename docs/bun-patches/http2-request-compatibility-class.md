## HTTP/2 request compatibility class

`crates/bunwasm-runtime/src/js/http2_request.ts` is a **Port** of Bun's
`src/js/node/http2.ts` at pinned upstream revision
`9510e74152073d850a18758ca41114d8f214ffa6`. The read-only patched source used
for comparison is `d71508d31edf06765c12adf0df137ef531539f68`.
The port covers `Http2ServerRequest`, its stream handlers, authority lookup and
compatibility socket proxy. Bun's MIT notice remains in the source file.

The class uses the existing Node Readable and stream validators. Private fields
and WeakMaps replace Bun symbols; ordinary JavaScript replaces JSC intrinsics.
The socket proxy uses `session.socket` in place of Bun's private socket slot.
Body flow and backpressure, trailers, abort/end/close/timeout events, headers,
HTTP version, setters and timeout forwarding follow the upstream class.
HTTP/2 transport remains unsupported. Response/request association and sharing
one socket proxy between response and request remain outside this adapter.

The builtin registration in `builtins.js` is an **original host adapter**.
It exposes the real class through named, default and CommonJS exports. No Hono
condition or HTTP/1 alias is involved. The regression reproduces the import in
`@hono/node-server@2.1.1/dist/index.mjs`, line 3, and compares the request
contract with installed native Bun 1.4.4 at `38afee6c84fcf48c0edb2466aa4b27d287a59c30`.
The import statement in the test is an original minimal reproducer, not copied
adapter implementation. The fixture owns its controlled stream transport.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| HTTP/2 request compatibility class | Port | Adapt Bun's Readable request wrapper and stream lifecycle without JSC intrinsics. |
| HTTP/2 request builtin registration | Host feature | Expose one real request constructor through the existing export generator. |
| HTTP/2 request regression | Original test | Check the failing named import and native request behavior with a controlled stream. |

`checks/runtime-http2-request.json` and `checks/native-http2-request.json`
register the source/link checks and guest fixture in maintained blocking gates.

[Ledger scope and pinned revisions](scope.md).
