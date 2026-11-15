# Browser guest coverage foundations

Classification: original adapter. No upstream implementation is copied or patched.

The catalogue, selector, supplemental artifact verifier and child recorder under
`scripts/browser-guest-*.ts` adapt the existing local browser drivers to explicit
owner and engine selections. They target this repository at
`b851ed101a6d0b2aa1ae36e0f6d9a0908853ff37`.

The catalogue and TSV fixture preserve the forty-four tuple identities recorded
in the source audit on November 14, 2026. Control proofs remain separate from
those identities. The selector enumerates the drivers' actual local imports and
fixtures, with historical exact-file inputs supplied by verified Git snapshots.
It does not replace native producer selection.

The artifact adapter reuses `browser-guest-site.ts`, `guest-build-receipt.ts`,
`guest-core-receipt.ts`, `engine-kind.ts` and `bash-web-guests.ts`. It preserves
original paired engine receipts and verifies the selected served program bytes,
shell/env bytes and pinned base assets. Only the producer can build the separate
interruption bundle. Consumers verify the existing artifact and compare immutable
hashes after execution.

The execution adapter runs each child through `run-with-timeout.mts`. Its durable
ledger distinguishes planned, passed, failed and not-run rows, and records the
supervisor's descendant-drain receipt independently of functional evidence.
No Bun, Node or WebKit source is adapted by this change.
