# Bun.serve status lines, maxRequestBodySize and network body clones

Class **Runtime behavior**. The behavioral reference is Bun at revision
`773e2edc7eb130b09996bdc0d0c42103b5a96f50`, checked against native Bun 1.4.4.

## Copied

- `crates/bunwasm-runtime/src/js/serve_status_text.ts` copies the table in Bun's
  `src/runtime/server/HTTPStatusText.rs` (`get`) and the `"{status} HM"` fallback that
  `src/runtime/server/RequestContext.rs` writes for a code outside it. Bun.serve writes these
  phrases whatever the Response's `statusText`, so `new Response("k")` goes out as `200 OK`
  rather than `200 `. node:http keeps its own table.

## Original adapters

- `serve_request_body.ts` and `serveHttp` in `net.js` apply `maxRequestBodySize` as Bun does: a
  number is truncated and clamped at 0, anything else keeps Bun's 128 MiB. A Content-Length
  over the cap is answered `413 Request Entity Too Large` with `Connection: close` before any
  handler runs. A chunked body that grows past the cap, whether streamed or arrived whole,
  fails the handler's reads (on the request and on its clone) with `Error: Request body
  exceeded maxRequestBodySize`; once the handler has started, the client gets `413 Payload
  Too Large` and the connection closes, so the handler's own response is dropped.
- `body_streams.ts` tees a byte stream (a fetch() or Bun.serve body) through a plain stream, so
  both branches get the same chunk objects as in Bun. The streams standard copies each chunk
  of a byte stream for the second branch.
- `bun_tcp.ts`: a Bun.connect() socket has `Symbol.dispose`, Bun's alias for `end()`.
- `web.js` lets a GET or HEAD Request carry a body, as Bun does. `fetch_args.ts` still rejects
  sending one, including a Request's own non-empty body, with Bun's
  `fetch() request with GET/HEAD method cannot have body.`
- `fetch_args.ts` makes Bun's early checks on an `s3://` fetch, in Bun's order: a stream body
  with a method other than POST or PUT, the s3 option types, the credentials (`s3` option or
  `S3_`/`AWS_` environment variables), then the method. There is no S3 client, so a request
  that passes them still fails as an unsupported URL; signing and sending are a missing feature,
  not a host limit.

The `serve-max-request-body`, `serve-request-clone`, `serve-status-line` and
`fetch-method-body-checks` fixtures compare this with native Bun.
