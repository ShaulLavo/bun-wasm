## Host-key TypeScript contracts

Class **Host feature**. `crates/bunwasm-runtime/src/js/crypto_host_keys.ts` and
`crypto_host_types.d.ts` are original adapters, not copied upstream implementations.
The source is the local host-key adapter at `ac43127c85addabed7e0c2a4883247ae074e858c`.
The contracts describe native CryptoKeys, structured import and export data, and
operation-specific asynchronous results. The provider still validates formats,
algorithms, usages and data. Missing byte arguments remain native validation inputs.

The approved executable changes replace the two dynamic method tables with explicit
captures followed by explicit bindings, tag cloned import data, and replace the
four-operation loop with named adapters sharing a result-generic implementation.
The hidden conversion cache uses one `get` instead of `has` followed by `get`.
The import bridge reads the tagged clone instead of repeating the format branch.
All other factory statements retain their original AST, including the strict
directive and final receiver-aware wrappers. Type erasure preserves the new source's
executable token lines and columns; the restructure does not preserve old locations.
The original snapshot is test data with a pinned SHA-256, not a second runtime.
No portable key implementation, native engine, or cryptographic algorithm changes.

The host-suite owner installs the root's locked test tools with lifecycle scripts
skipped before either application's normal install. This makes its AST parser
available in a fresh Web CI job without building package exports there. Package
verification retains normal preparation, including the pinned Waffle exports.

Discovery uses `checks/web-crypto-host-keys.json` for the unchanged 30 controls,
`checks/quality-crypto-host-setup.json` for setup regressions, and
`checks/native-runtime-ts-host-crypto-keys.json` for the existing no-build fixture
owner. The Web factory probe strips the converted TypeScript source with Node's
standard stripping API. Original JavaScript fixtures still load unchanged.

The two foundation selection assertions compare only their immutable historical
selections, matching the existing migration proof. New feature manifests do not
alter that proof's original batch membership, failure handling or build count.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crypto_host_keys.ts` and `crypto_host_types.d.ts`](#host-key-typescript-contracts) | Host feature | Original finite native-provider and key-bridge contracts based on the local adapter at the revision above. |
| [`scripts/crypto-host-keys.test.ts`, its two fixtures, and `tests/fixtures/runtime-ts-host-crypto-keys/`](#host-key-typescript-contracts) | Host feature | Original source, type and synthetic provider controls, plus the existing runtime fixture. |
| [`scripts/test-web-host.sh`, `scripts/crypto-host-setup.test.ts`, and feature-owned check manifests](#host-key-typescript-contracts) | Host feature | Original root-first locked tool setup and fail-closed fixture regressions in the existing blocking owners. |
| [`web/tests/crypto-key-adapter-probe.mjs`](#host-key-typescript-contracts) | Host feature | Original fixture loader uses Node's type-stripping API for the converted adapter. |

[Ledger scope and pinned revisions](scope.md).
