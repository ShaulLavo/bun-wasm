# Sandbox storage

Status: Approved. Implementation in progress.

## Current checkpoint

Bounded preservation, immutable strict-transaction index, conditional restore,
editor pending-save retention, installer retry detection, and awaited checkpoints
are implemented. Pure, native browser index, async UI, and selector checks pass.
The shared producer packages the sandbox once and the guest regression harness is
prepared. A 240 MiB live old-code control passed Vanilla's checkpoint and failed
React's checkpoint despite its ready indicator.

Production maintenance creation and pre-runtime reclamation remain blocked on the
published Waffle maintenance API tuple. Current pins do not export that API. No
compatibility fallback or private Waffle database access is used. The draft must
not merge before wiring that tuple, executing the actual guest cases, and running
the bounded eight-template storage measurement and warm Next reinstall.

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
independent review amendments. Integration waits for the actual Waffle API and
published patch tuple rather than inventing a parallel storage contract.

## Gates

Pure checks belong to Web through `scripts/sandbox-storage.test.ts`. Native
IndexedDB tests must establish transaction completion and conditional snapshot
acknowledgement. Real sandbox tests belong to Browser guest and consume its shared
producer artifact, extended once to include the sandbox. No Waffle matrix is
duplicated here. Parent owns review, CI, and merge.
