# DNS lookup capability boundary

Class **Host feature**, original bun-wasm adapter boundary. This record documents
an implementation blocker; it adds no runtime adapter, copied implementation or
upstream patch.

The fallback `node:dns` and `node:dns/promises` factories in
`crates/bunwasm-runtime/src/js/builtins.js` currently throw unsupported-operation
errors for lookup. `Bun.dns.lookup` in the same directory's `bun.js` is also a
stub. Working HTTP requests and loopback sockets do not provide standalone
address lookup.

Public-contract references are Bun `src/js/node/dns.ts` and
`src/js/node/dns.promises.ts` at upstream
`9510e74152073d850a18758ca41114d8f214ffa6`. The main module uses `Bun.dns` with
the system backend for hostname lookup. The promise module aliases the main
module's promise object. Its existing validation, IP-literal paths, ordering
and result mapping are candidates for reuse once the backing capability exists;
no part of that implementation was copied or adapted in this change.

At Waffle pin `b20fad173ebaa225cb87c51776f35edaaafd4a40`,
`browser/net/host.ts` and `browser/net/protocol.ts` expose no side-effect-free
lookup operation. Bun's 14-slot network ABI likewise has none. Waffle must own
namespace address lookup and its browser localhost policy. Opening a connection
and reading its peer address is not a substitute.

The pending consumer is Vite 7.1.12 startup under Vitest 3.2.4. It calls both
`dns.promises.lookup("localhost")` and the `{ verbatim: true }` overload before
starting its server. Those calls still fail. This change claims diagnosis only,
not working DNS, Vitest or browser compatibility.
