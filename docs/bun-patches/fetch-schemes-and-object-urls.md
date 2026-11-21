# fetch() schemes, object URLs and Bun.FetchSession

Class **Runtime behavior**, **original adapters** in `crates/bunwasm-runtime/src/js/web.js`
(`fetch`, `remoteUrl`, `fetchObjectUrl`) and `bun.js` (`FetchSession`). No upstream code is
copied. The behavioral reference is Bun at revision
`9510e74152073d850a18758ca41114d8f214ffa6` (`src/runtime/webcore/fetch.rs`, `src/url/lib.rs`
`parse_protocol` and `is_blob`, and `test/js/web/fetch/fetch-args.test.ts`), checked against
native Bun 1.4.4.

- Bun's own URL reader takes a scheme only before `://`. `fetch("localhost:3000/a")` is
  therefore a request to host `localhost`, port 3000, over http, though `new URL()` reads
  `localhost` as its scheme. The runtime sends a `host:port` URL like that as `http://…`.
  Bun also sends other scheme-less strings (`mailto:me@example.com`) to the host before
  the colon; the runtime still refuses those.
- Any scheme before `://` other than `http:`, `https:` and `s3:` rejects with Bun's
  `TypeError` `ERR_INVALID_ARG_VALUE` "protocol must be http:, https: or s3:". The runtime
  checks this itself now, so the Browser engine gives Bun's error too instead of its host's.
- An object URL (`blob:` and a UUID, the only form Bun reads as one) answers with a 200
  Response over its Blob, typed by the Blob; the method and body are ignored. An unregistered
  or revoked one rejects with `ERR_INVALID_ARG_VALUE` "Failed to resolve blob:…".
- `Bun.FetchSession` exists, with `fetch()` and `close()`. In Bun a session owns its own
  connections; the host keeps one shared set, so a session's `fetch()` is `fetch()` and
  `close()` has nothing to release.

Bun's S3 client is not part of bun-wasm, so `s3:` requests (including their early argument
errors, such as "Only POST and PUT do support body when using S3") still fail at the host.
That is a missing feature, not a host limit.

The `fetch-schemes-and-object-urls` fixture compares this with native Bun.
