## Package resolution

`crates/bunwasm-runtime/src/resolve.rs` is an original bun-wasm adapter for
package discovery and the public package `exports` and `imports` contracts.
No upstream implementation is copied. The related reference behavior is Bun's
`src/resolver/` at the pinned revision in [scope](scope.md), plus Node's
`lib/internal/modules/esm/resolve.js`, particularly `patternKeyCompare` and
`resolvePackageTarget`, observed in Node v26.12.1. These are behavioral
references, not source replacements.

Matching exact keys precedes pattern selection. Patterns compare their prefix
length and then their complete key length, so a suffix-specific pattern wins
regardless of manifest order. Only a selected pattern's target is evaluated.
Single-star patterns require a nonempty capture; legacy folder mappings retain
their existing fallback position.

A package selected through `exports`, including a self-reference, keeps its
resolution failure instead of loading an ancestor version. Each candidate reuses
its parsed manifest so diagnostic notes are not duplicated. Unresolved legacy
`main` and index lookups retain Bun's ancestor fallback. A null top-level
`exports` field does not activate exports or self-reference selection. Bun 1.4.4 controls
confirm this distinction; Node's legacy ESM and CommonJS rules differ.

Target selection distinguishes an unmatched condition, null, an invalid target,
and a selected path. Conditional objects continue only after an unmatched
condition. Arrays can skip unmatched, null and invalid targets, but do not retry
after a valid path names a missing file. Empty arrays are null. Relative target strings reject parent, dot and
`node_modules` segments. Invalid pattern captures are terminal before target-array
fallback is considered.
The adapter preserves its existing Node-style null/invalid array fallback.
Native Bun 1.4.4 instead rejects those array entries, while Node v26.12.1 skips
them. This change does not claim to reconcile that pre-existing difference.

`resolve_tests.rs` uses real temporary package directories and cleans each one
on drop. The feature-owned `package-resolution` fixture exercises actual imports
and `createRequire` calls in compiled guests. Its TypeScript setup writes tiny
ES module marker files as test data. `.mjs` markers also let native Node execute
the same installed-package controls without its restriction on stripping types
inside `node_modules`. The fixture and tests are original, not upstream copies.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| Package discovery and target selection in `resolve.rs` | Host feature | Original package-boundary, pattern-order and conditional/array target adapters. |
| `resolve_tests.rs`, `tests/fixtures/package-resolution/`, `checks/native-package-resolution.json` | Host feature | Original resolver regressions and blocking guest fixture registration. |

[Ledger scope and pinned revisions](scope.md).
