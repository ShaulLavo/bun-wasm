# Native quality handoff packaging

Original bun-wasm CI tooling. No upstream source is copied or adapted.

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `scripts/ci-native-handoff.ts` | Host feature, original adapter | Stream the complete patched-head and pinned-base object sets into destination-side Git pack indexing. |
| `scripts/ci-native-handoff.test.ts` | Test fixture | Exercise real Git across filesystem boundaries, including import verification and failed-pack cleanup. |

Git's output-prefix `pack-objects` mode creates a temporary pack in the source
object database and renames it to the output prefix. That rename fails with
`EXDEV` when the private runner temp directory and checkout are separate mounts.
`pack-objects --stdout` feeds `index-pack --stdin` with the staged Git directory
as its repository. Git writes, indexes and names the pack on that destination
filesystem. The shell retains `pipefail`, so enumeration, packing or indexing
failure cannot publish a successful handoff manifest.

The selected objects, shallow commits, patched-head index, archive checksums,
manifest identity and consumer verification stay unchanged. The Linux regression
uses `BUN_WASM_CROSS_FILESYSTEM_TMPDIR`, defaulting to `/dev/shm`, for its tiny
destination. It requires different device identities and removes its fixture
on success and failure. It checks both complete trees and excludes unrelated
history. This is registered through the existing quality handoff manifest.

[Ledger scope and pinned revisions](scope.md).
