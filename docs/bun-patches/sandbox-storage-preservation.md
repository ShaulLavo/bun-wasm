# Sandbox source preservation

Class **Host feature**, original sandbox adapter. No upstream source is copied.

The sandbox retains complete user trees before reclaiming idle installed projects.
Its policy, bounded reader, snapshot index, restore markers, and editor recovery
live in `sandbox/src/workspace-*.ts`, `editor.ts`, and `sandbox.ts`. The side index
uses native strict IndexedDB transactions and immutable snapshot identities.
Acknowledgement removes only the matching snapshot after the restored tree flushes.

Only exact catalog-owned generated roots are omitted. Dotfiles, unknown build and
dist paths, files outside the app, binary bytes, deleted template files, and empty
directories are retained. Fresh files use mode 0600 and directories use 0700.
Restored mtimes are deliberately fresh. Links, sockets, hard links, nondefault
modes, incomplete template seeds, trees over 8 MiB or 10,000 retained entries,
and reads exceeding five seconds refuse eviction and keep the original workspace.

Waffle owns stored-tree inspection, runtime ownership, and native deletion. The
sandbox adapter uses its public maintenance contract and does not access its
private IndexedDB schema or lock names. Preservation failure never authorizes
deletion. Live recovery reclaims only idle projects and retries the failed phase
once. Active-project destruction is outside this adapter.

Pure checks, native IndexedDB checks, and the shared Browser guest site producer
are registered through feature-owned check manifests. The producer packages the
sandbox and playground once from its already-built guest. Browser consumers verify
the same file inventory and guest identity before using that artifact.
