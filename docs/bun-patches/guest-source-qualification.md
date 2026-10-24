# Guest source qualification

These are original repository build and publication adapters, not copied upstream
implementations. There is no upstream source revision for this adapter. The imported
Bun revision and patch series remain owned by `scripts/sync-bun.sh` and the existing
patch records. This change neither edits nor copies Bun, Node or WebKit source.

| Patch or source | Class | Change |
| --- | --- | --- |
| `scripts/guest-source-manifest.ts` | Original adapter | Inventory selected committed source, installed inputs and resolved tools; reject hidden drift and unsupported selections. |
| `scripts/guest-build-receipt.ts` | Original adapter | Bind matching start/end inventories to the exact artifact hash and byte count. |
| `scripts/build*.sh`, `.github/workflows/ci.yml` source-cache producer | Original adapters | Use the selected executable environment and temporary snapshot-file contract with the exact existing build tuples. |
| `scripts/guest-acceptance.ts` | Original adapter | Validate source receipts and artifact/build labels before private publication snapshotting. |

Imported Bun symlinks retain their committed raw link text and file kind, resolve
inside that import, and have their consumed target bytes inventoried. Primary
repository source symlinks remain forbidden. Registry source bytes, ambient config,
host libraries, cache provenance and remaining WebKit/ICU inputs are documented
omissions, not optional checks. Start/end checks do not prove continuous immutability
or that compilation ran. No old receipt is upgraded.

The native-input selector also tracks the new manifest module, just as it tracks
the receipt module that imports it. Cache saves, keys and gate ordering are unchanged.

Tests under `tests/package/guest-*.test.ts` and the adapted network preflight test
retain the package CI owner's existing glob. `web/tests/shell-consumer-controls.test.ts`
retains the Web test-directory owner. Neither needs a duplicate feature manifest.
See [guest build receipts](../guest-build-receipts.md) for the full contract and the
separate unoptimized CI source-cache build profile.
