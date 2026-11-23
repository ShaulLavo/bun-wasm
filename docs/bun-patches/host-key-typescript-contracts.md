## Host-key TypeScript contracts

Class **Host feature**. `crates/bunwasm-runtime/src/js/crypto_host_types.d.ts` is an original
contract, not copied upstream code. It types the runtime WebCrypto provider's key records
that `crypto_keys.ts`, `structuredClone` and `postMessage` share.

The native-provider bridge `crypto_host_keys.ts`, its source and synthetic-provider controls
(`scripts/crypto-host-keys.test.ts` and its two fixtures) and the Web factory probe were
removed when the browser engine moved to the runtime's own provider.
`tests/fixtures/runtime-ts-host-crypto-keys/` now checks that every engine, the browser
engine included, uses that provider for import, KeyObject conversion, derivation and
wrapping.

The host-suite owner installs the root's locked test tools with lifecycle scripts
skipped before either application's normal install. This makes its AST parser
available in a fresh Web CI job without building package exports there. Package
verification retains normal preparation, including the pinned Waffle exports.
`checks/quality-crypto-host-setup.json` owns those setup regressions and the fixture's
discovery owner.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crypto_host_types.d.ts`](#host-key-typescript-contracts) | Host feature | Original contracts for the provider's key records. |
| [`tests/fixtures/runtime-ts-host-crypto-keys/`](#host-key-typescript-contracts) | Host feature | Original runtime fixture for the shared provider. |
| [`scripts/test-web-host.sh`, `scripts/crypto-host-setup.test.ts`, and feature-owned check manifests](#host-key-typescript-contracts) | Host feature | Original root-first locked tool setup and fail-closed fixture regressions in the existing blocking owners. |

[Ledger scope and pinned revisions](scope.md).
