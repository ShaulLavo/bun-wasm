## Listen hostname data validation

Class **Host feature**, **original adapter** in
`crates/bunwasm-runtime/src/js/net_hostname.ts`, the three data-wrapper edits in
`net.js`, and the `net_address` declaration in `runtime.d.ts`.
No upstream implementation is copied. Public-contract references are Bun
`test/js/bun/net/socket-dns-error.test.ts` and `src/js/node/net.ts` at pinned base
`9510e74152073d850a18758ca41114d8f214ffa6`, patched tree
`d71508d31edf06765c12adf0df137ef531539f68`.

The helper reuses the existing classified IP predicate. It rejects non-string
inputs, whitespace, malformed separators, empty labels and labels over 63 UTF-8
bytes. Valid names and legacy IPv4 spellings pass through unchanged.
The shared listen wrapper validates before the existing host call and adds the
caller's hostname to an already-created `ENOTFOUND` error. `Bun.serve` alone
opts into bracketed IPv6 normalization before that wrapper. Other callers keep
the default rejection policy.

`scripts/net-hostname.test.ts` evaluates the helper, isolated wrapper functions
and the `Bun.serve` hostname expression with synthetic strings and error records.
It does not execute listener startup, DNS, connect, sockets or a guest.
Resolver delivery, bind behavior and socket lifecycle remain outside this change.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Listen hostname data validation](#listen-hostname-data-validation) | Host feature | Original hostname syntax checks, bracket normalization and error metadata before the existing host call. |

[Ledger scope and pinned revisions](scope.md).
