# fetch() arguments

Class: Original adapter.

`crates/bunwasm-runtime/src/js/fetch_args.ts` reads and checks `fetch()`'s
arguments as `fetch_impl` in Bun's `src/runtime/webcore/fetch.rs` does at
revision `9510e74152073d850a18758ca41114d8f214ffa6`, checked against native
Bun 1.4.4. No upstream code is copied. `web.js`'s `fetch` calls it first and
builds the request from its result; `net.js` sends it as before.

The first argument is a `Request`, a string, or another value whose string
form is an absolute URL. Any other object is a request init with a `url`
property, as in Bun. No arguments, a blank URL and an unparsable URL reject
with Bun's messages and codes. A `data:` URL is answered before any option is
read; one without a comma or with invalid base64 rejects with
`failed to fetch the data URL`.

Options are read from the second argument and then from the init object, in
Bun's order: `method`, `decompress`, `compress`, `maxRedirects`, `tls`,
`unix`, `protocol`, `timeout`, `redirect`, `keepalive`, `verbose`, `proxy`,
`signal`, `body`, `headers`. So a throwing getter rejects before anything is
sent. Bun's own options change nothing on this host, but their values are
checked with Bun's messages: `compress`, `maxRedirects`, `protocol`, the
`tls` file fields (`ca`, `cert`, `key`) and `rejectUnauthorized`,
`serverName`, `passphrase`, the `redirect` mode, the proxy URL, a non-signal
`signal`, a proxy combined with `unix`, a used `Request` body, and a body on
GET or HEAD. A `signal: null` detaches from the input request's signal.

Not covered: a `Blob` in `tls.ca` that is not a `Bun.file` is accepted (Bun
rejects it), `FetchSession` and `session` are not read, and `tls.checkServerIdentity`
is not checked.

`web.js` also gives `AbortSignal`'s default abort reason Bun's message,
`The operation was aborted.` (it was `This operation was aborted`).

The `fetch-argument-checks` fixture covers these rules.
