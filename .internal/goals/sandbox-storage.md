# Sandbox storage

Status: Approved. Implementation in progress.

## Current checkpoint

Bounded preservation, immutable strict-transaction index, conditional restore,
editor pending-save retention, installer retry detection, and awaited checkpoints
are implemented. Pure, native browser index, async UI, and selector checks pass.
The shared producer packages the sandbox once and the guest regression harness is
prepared. A 240 MiB live old-code control passed Vanilla's checkpoint and failed
React's checkpoint despite its ready indicator.

Production maintenance creation and pre-runtime reclamation use the published
Waffle 0.0.124 runtime and relay, host interface 2, at source `318ad8cc`. Public
archive hashes and sizes match the delivered tuple. Candidate overlays and backups
are removed, and all consumers use frozen released dependencies. No compatibility
fallback or private Waffle database access is used. Final matching-source guest
and site qualification follows the unchanged strict producer; borrowed-guest
development evidence remains separate. The bounded eight-template measurement
and warm Next reinstall are recorded and are not repeated for the pin change.

Keep active workspaces and one eligible idle install. Before removing an idle
workspace, preserve its complete user tree in a strict IndexedDB transaction.
Restore by immutable snapshot identity before seeding a template. Unsupported or
oversized trees remain installed. Recovery reclaims idle installs and retries the
failed install or checkpoint once, preserving the current page and pending edits.

## Throughput checkpoint

- Blocking first steps. Read the reviewed storage design, trace sandbox startup,
  and agree the Waffle public maintenance contract before integration.
- Independent workstreams. Waffle owns read-only inspection and deletion exclusion.
  This branch owns sandbox snapshots, index, policy, integration, and its tests.
- Shared mutable state. Immutable snapshot IDs separate preservation attempts.
  An origin lock serializes eviction, restore, and reset against fresh index data.
- Smallest safe decomposition. One implementation worker owns the coupled sandbox
  flow. Parent supplies independent review. No nested workers.

Architect exploration skipped. The parent supplied an approved design and binding
independent review amendments. Development uses the actual immutable Waffle
candidate; final delivery requires its published patch tuple.

## Gates

Pure checks belong to Web through `scripts/sandbox-storage.test.ts`. Native
IndexedDB tests must establish transaction completion and conditional snapshot
acknowledgement. Real sandbox tests belong to Browser guest and consume its shared
producer artifact, extended once to include the sandbox. No Waffle matrix is
duplicated here. Parent owns review, CI, and merge.

## Adjacent findings

The guest `node:fs` adapter implements `chmodSync(path)` as `void statSync(path)`
at `crates/bunwasm-runtime/src/js/node_fs.js:697`; `lchmodSync` and `fchmodSync`
are no-ops too. A real Vite-config guest call to chmodSync(.env, 0400) therefore
left ordinary recreatable permissions and the storage test correctly evicted it.
This is a guest permission-API gap, not a storage refusal failure. Reproducer:
create a file, call chmodSync(path, 0400), inspect retained metadata through
Waffle's public idle walk after closing the runtime. The code directly establishes
that no mode mutation is issued. Fix in the owning filesystem compatibility work,
with actual supported mode mutation and all-engine tests; do not silently report
success for unavailable chmod. The storage integration fixture uses a real guest
symlink for unsupported-data refusal instead. Pure preservation tests still reject
nondefault modes. No chmod fix or additional guest build belongs to this branch.

WebKit also exposes an existing ambiguous preview owner when two runtimes serve
the same virtual port. With Hono active and Vanilla opened in another page, both
iframes at `/__preview/5173/` render Hono while the Vanilla terminal reports Vite
ready. Chromium and Firefox passed the corresponding scenario. Explicit
bringToFront did not fix WebKit in a second bounded diagnosis. Waffle's public
`browser/service-worker.ts:158` forwards to the first accepting non-preview window
from `clients.matchAll`; `routeSocket` does the same near line 195. The URL has no
owning-runtime identity. Raw reproductions are retained in the storage report's
`webkit-diagnosis-one.log` and `webkit-diagnosis-two.log`. A general fix belongs to
preview ownership, including HTTP and socket routing, with two distinct apps on
the same port and foreground/background permutations. This branch does not edit
the preview protocol or claim to fix that routing bug.
