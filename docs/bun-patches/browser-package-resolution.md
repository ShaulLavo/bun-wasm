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

Existing installed-file references also enter through that canonical alias. This
includes a fixture's relative `node_modules/waffle` import from outside the
package, even if Bun visits it before the first bare package import. The target
must still resolve within the selected installed package. Public export checks
and package-escape refusals remain unchanged.

Without that normalization, the persistence fixture's existing conformance-only
selector and the runtime read different module-local symbols. Its OPFS-labeled
page then silently uses the default IndexedDB takeover behavior. Two synthetic
builds check both import orders, requiring one module input and exact symbol
identity. The unchanged real OPFS waiting and recovery control verifies the
consumer behavior. No private capability or package export is added.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`scripts/browser-build.ts`](#browser-package-resolution) | Host feature | Resolve the consumer's exported runtime files through an absolute package path that works with Bun's isolated linker. |

[Ledger scope and pinned revisions](scope.md).
