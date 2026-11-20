# Fetch client error codes and redirect statuses

Class **Host feature**, **original adapters** in the native reqwest binding
(`crates/bunwasm-host/src/net/fetch.rs` and `crates/bunwasm-host/src/net/error.rs`) and
the Browser engine's Node test host (`web/scripts/node-net.mjs`). No upstream code is
copied or adapted. The behavioral reference is Bun's HTTP client at revision
`9510e74152073d850a18758ca41114d8f214ffa6` (`test/js/web/fetch/fetch-redirect.test.ts`
and `client-fetch.test.ts`), checked against native Bun 1.4.4.

A response head that does not parse rejects with Bun's code and message
(`<code> fetching "<url>". For more information, pass ...`):

- `InvalidContentLength` for a Content-Length that is not plain digits, such as `1_0`.
- `Malformed_HTTP_Response` for a bad header line: a control character other than tab
  in a value (a Location with a raw vertical tab, SOH or DEL) or an obs-fold
  continuation.

The native host reads these from hyper's parse error in the reqwest error chain; hyper
only names the failing part in its message, so the content-length case is told apart
by that text. The Node host maps llhttp's `HPE_*` codes. A bad status line keeps its
previous error, as Bun reports that as a closed connection (`ECONNRESET`).

Only the WHATWG redirect statuses (301, 302, 303, 307 and 308) are redirects. Under
`redirect: "error"` they reject with `UnexpectedRedirect` whether or not they carry a
Location, and 300, 304, 305 and 306 come back as ordinary responses. A followed
redirect to a scheme other than http or https rejects with
`UnsupportedRedirectProtocol` before any request is sent, and a Location that does not
resolve to a URL rejects with `RedirectURLInvalid`.

In a real browser, Waffle's network helper handles the redirect modes and reports
its own messages without Bun's codes, and the page's fetch gives one generic error
for every malformed response, so these codes apply to the native launcher and the
Node test host.

The `fetch-client-errors` fixture and the `net::tests::fetch_*` launcher tests
compare this with native Bun.
