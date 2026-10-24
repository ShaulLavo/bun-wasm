## Blocking Web guest checks

Original bun-wasm CI and test tooling. No upstream implementation is copied or
adapted here. The seven existing artifact-backed Web cases move out of the
fixture-free test glob without changing their assertions, fixtures or timeouts.
The shared compose helper keeps the existing executable, lint and install checks.

`scripts/test-web-guests.ts` verifies the existing guest build receipts and shared
patched Bun/sysroot identity before running a selected group. The native job
builds tools once in its Cargo target and runs both guest commands before its
four successful-only final saves. Cache identities retain the separate native-v2,
guarded native-v4 fallback, JSC prebuild and JSC Cargo contracts.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| Web guest CI, receipt preparation, selector and source probes | Host feature | Original adapters and workflow wiring; moved bun-wasm tests, no new upstream source. |

[Ledger scope and pinned revisions](scope.md).
