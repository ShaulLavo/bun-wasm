# Fetch response URLs, header bytes and resolver errors

Class **Host feature**, **original adapters** in the native reqwest binding
(`crates/bunwasm-host/src/net/fetch.rs` and `error.rs`) and the Browser engine's Node
test host (`web/scripts/node-net.mjs`). No upstream code is copied or adapted. The
behavioral reference is Bun's HTTP client at revision
`9510e74152073d850a18758ca41114d8f214ffa6` (`test/js/web/fetch/client-fetch.test.ts`
and `fetch-redirect.test.ts`), checked against native Bun 1.4.4.

- **Header bytes.** The native host decoded response header values as UTF-8. Bun, like
  browsers, takes each byte as one character (Latin-1), so a value a server wrote as
  Latin-1 text, or UTF-8 bytes that the page decodes itself, keeps its exact bytes and
  length. The Node host already did this.
- **Fragments.** A URL fragment is never sent. The native host passed it to the HTTP
  client, where a long one (the 96 KiB padding in the multi-hop redirect test) did not
  fit a request target and failed as `ERR_INVALID_URL`. Each hop is now sent without its
  fragment, and `Response.url` keeps it, as in Bun. The Node host raises Node's 16 KiB
  response head limit to 512 KiB, so it follows such a Location too (Bun allows redirect
  URLs up to 128 KiB).
- **Resolver errors.** An `ENOTFOUND` fetch error names the host that failed to resolve
  and carries it as `hostname`, with `syscall: "getaddrinfo"`. After a redirect that is
  the redirect target, not the original host.

Bun's per-request `proxy` option is not implemented; the resolver test's proxy case
still fails for that reason.

The `fetch-header-bytes-and-redirect-urls` fixture and the
`net::tests::fetch_sends_no_fragment_and_reads_header_bytes_as_latin1` launcher test
compare this with native Bun.
