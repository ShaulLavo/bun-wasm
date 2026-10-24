## Browser package resolution

Class **Host feature** for the original adapter in `scripts/browser-build.ts`. The adapter resolves
the consuming app's declared `waffle` browser exports and verifies that each target stays inside
the installed package. Bare package imports and relative runtime imports return paths under
the same consumer-installed alias, preserving one module identity without exposing physical
cache directory names containing `..` to Bun's file-namespace plugin-path check. Mixing a
symlink alias with physical relative imports duplicated `FilesystemError` and broke the
installer's typed EEXIST handling during reinstall. A synthetic symlinked-package build checks
error-constructor identity with a double-dot cache name, alongside real-browser reinstall
acceptance. No upstream source is copied.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`scripts/browser-build.ts`](#browser-package-resolution) | Host feature | Resolve the consumer's exported runtime files through an absolute package path that works with Bun's isolated linker. |

[Ledger scope and pinned revisions](scope.md).
