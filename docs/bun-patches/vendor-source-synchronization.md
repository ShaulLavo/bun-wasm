## Vendor source synchronization

Class **Host feature**, original `scripts/sync-bun.sh` orchestration and
`scripts/sync-bun.test.ts` fixtures; no upstream implementation is copied. The
pinned Bun revision and checked-in patch series remain authoritative. Existing
clones and linked worktrees (whose `.git` is a file) must be clean before sync.
An isolated Git index derives the desired tree from every checked-in patch;
matching shared `wasm` history can be reused, while a stale ref is reconstructed
in an owned disposable worktree without resetting another checkout's branch.
That temporary worktree and index are removed on both success and failure.
`--source-only` verifies source without downloading dependencies or running
codegen, and `--bun-dir` supports an explicit source checkout. Regression tests
cover an old detached worktree, a stale shared ref, repeat sync, cleanup, and
refusal to overwrite tracked or untracked work.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Vendor source synchronization](#vendor-source-synchronization) | Host feature | Original patch-tree verification updates existing clones and detached worktrees without overwriting local changes. |

[Ledger scope and pinned revisions](scope.md).
