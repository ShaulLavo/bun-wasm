# Node TLS identity policy

## Port and license

`crates/bunwasm-runtime/src/js/tls_identity.ts` ports the pure server-identity helpers from Bun `src/js/node/tls.ts` at commit `9510e74152073d850a18758ca41114d8f214ffa6`. The helpers run inside the existing typed runtime factory, without Node imports or engine intrinsics. Bun and the Node-derived implementation are MIT licensed. The retained notice is in [`scripts/fixtures/tls-identity/LICENSE.txt`](../../scripts/fixtures/tls-identity/LICENSE.txt).

[`scripts/fixtures/tls-identity/upstream.json`](../../scripts/fixtures/tls-identity/upstream.json) records the exact Git blob, SHA-256, byte count, and classification for every inspected upstream file. `verify-upstream.ts` reads those objects at the pin, not the vendor checkout's mutable HEAD, and reproduces the pure-case fixture.

## Matching policy

The port retains the pinned `unfqdn`, `splitHost`, wildcard, escaped-SAN, and `checkServerIdentity` behavior from lines 261-431. DNS Subject Alternative Names take precedence over Common Names, including an empty `DNS:` entry. URI names and IP names never become DNS names. An IP target matches only a canonical IP Subject Alternative Name, not a Common Name or a DNS entry. IPv6 zone IDs identify the client's interface and are excluded from address comparison.

Wildcards occupy at most one part of the leftmost label. They do not cross labels, match an empty label, occupy multiple positions, or match a two-label `*.tld` name. A wildcard inside a Punycode A-label is literal. Unicode certificate patterns remain unsupported, as in the pin. Expected Unicode DNS names use the existing native IDNA conversion.

The local adaptations are deliberate:

- The quoted-SAN scanner finds JSON string boundaries, then `JSON.parse` enforces the same JSON grammar as the pinned regular expression. There is no lint suppression.
- Expected DNS names reject control characters, NUL, empty labels, oversized labels, and URL delimiters before the URL-backed `domainToASCII` hook. This prevents path truncation. The hook's IPv6 parser also supplies canonical IP text, after the existing IP predicate validates the full input.
- Diagnostics escape controls and cap each displayed name at 256 input code units. Errors retain `code` and `reason`, with the usual hostname-mismatch message prefix, but do not attach certificate, DER, PEM, or private-key data.
- `selectTarget` and `verifyIdentity` are original adapters, classified separately below. They do not implement native chain verification or socket lifetime.

## Caller boundary

The factory returns `BunWasm.TlsIdentity` with `checkServerIdentity(hostname, cert)`, `selectTarget(options)`, and `verifyIdentity(verification)`. The declaration file owns the peer, target, callback, verification-request, and decision types.

`selectTarget` chooses a nonempty explicit `servername`, then `connectHost`, then `originalTarget`. Empty `servername` suppresses SNI but does not suppress verification. Only an explicit DNS servername produces SNI. IP literals never produce SNI, even when explicitly supplied. A missing identity returns `ERR_TLS_HOSTNAME_REQUIRED` unless `rejectUnauthorized` is false. The result preserves the original expected hostname for the JS callback and normalizes DNS SNI separately.

`verifyIdentity` accepts a discriminated chain result. A failed-chain input cannot carry a callback in the declared type and never invokes one at runtime. A verified-chain input runs the custom callback once, or the builtin matcher when no custom callback exists. Returned identity errors become rejected decisions or truthful unauthorized decisions under explicit opt-out. Thrown errors and invalid callback results reject even under opt-out. The caller binds any callback receiver it needs and owns the one-call-per-handshake rule, callback-triggered destruction, and the native acceptance step. An `authorized` decision never follows a failed chain.

## Test classification and limits

| Source or local unit | Classification | Coverage |
| --- | --- | --- |
| Bun `src/js/node/tls.ts`, lines 261-431 | Port | Pure identity helpers only. Native contexts, sockets, servers, and other exports are deferred. |
| Node `test-tls-check-server-identity.js` | Ported cases | All 59 pure inputs and expected reasons are retained. Only the newline diagnostic assertion changes to escaped `\u000a`. No original assertion file runs unmodified. |
| Bun `node-tls-connect-hostname-verification.test.ts` | Deferred | The manifest lists all 20 client, native-server, HTTPS, HTTP2, and Bun.connect cases. None counts as a runtime pass here. |
| Bun `src/js/internal/url.ts`, `src/js/internal/tls.ts`, and `src/js/node/punycode.ts` | Deferred | No copied implementation. Existing runtime hooks supply IDNA, IP parsing, and Error identification. |
| Bun `root_certs.der` | Unchanged source | Only its pinned hash is recorded. The native TLS lane owns trust data and chain verification. |
| Target selection, chain-result policy, declarations, and source tests | Original adapter | Local source tests run the actual factory after normal and compact runtime erasure. Strict positive and negative type tests exercise the declared boundary. |

The source tests use host implementations of the declared native IDNA and Error hooks. They prove the ported functions and callback ordering, not the actual guest native hooks, a certificate chain, a network handshake, or application TLS. Native, guest, browser, PostgreSQL, and artifact-admission checks remain separate integration work.

## Retained MIT notice

```text
Copyright Joyent, Inc. and other Node contributors.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.
```
