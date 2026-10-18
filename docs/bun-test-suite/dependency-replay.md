# Dependency setup replay

<!-- dependency-replay:start -->
## Measured results

The 2026-10-18 replay selects the 49 files previously assigned to category c for an uninstalled suite dependency. It provisions pinned packages and the suite's missing bake alias. The same four guest artifacts, launcher, upstream revision and deadlines are used before and after. The supplemental dependency tree and the runner's alias setup change.

| Engine | Selected files | Fully passing before → after | Observed passes before → after | File timeouts before → after |
| --- | --- | --- | --- | --- |
| quickjs | 49 | 0 → 8 | 306 → 375 | 0 → 0 |
| jsc | 49 | 0 → 8 | 306 → 375 | 0 → 0 |
| browser | 49 | 0 → 9 | 304 → 378 | 0 → 0 |

| Category | Full-census failure assignments | Updated recorded failure assignments |
| --- | --- | --- |
| a | 84 | 95 |
| b | 81 | 82 |
| c | 54 | 5 |
| d | 1451 | 1479 |
| e | 93 | 93 |
| f | 23 | 24 |

[dependency-replay.json](dependency-replay.json) records all 49 outcomes and first failures on each engine, with input provenance and raw-result hashes. [dependency-files.txt](dependency-files.txt) fixes the selection. [Dependency setup](dependencies/setup.md) gives the install and replay commands and version sources.

The selected rows in failures.tsv use this replay's QuickJS first failures, with category f only when the file fully passes on another engine. Passing and skip-only files have no failure row. Updated assignment counts and the triage groups are generated from failures.tsv. The full-census guide and summary.json retain the earlier 2,305-file observation; this focused replay does not claim a new full-suite total.
<!-- dependency-replay:end -->
