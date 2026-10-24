# Independent landing records

Feature PRs keep package versions, Cargo versions and local lockfile version
records unchanged. A release or a required consumer pin owns its patch bump.
Do not create a standalone version-churn PR.

## Provenance records

The ledger migration uses heading-based files rather than a metadata manifest.
Both shapes let a feature own a separate file. Headings preserve the original
prose, revisions, classification rows and Git history without a second metadata
schema or generated central index. A feature updates its record or adds a file.
The short `bun-patches.md` entrypoint stays unchanged.

The splitter uses the immutable pre-migration commit, not an edited input file:

```sh
source env.sh
bun scripts/migrations/split-bun-patches.ts --check
```

`--write` reproduces the migration and rewrites tracked Markdown crosslinks.
It is a historical migration command, not a generator to run after later feature
edits. The committed map records every former heading and explicit alias.
Classification rows move to the record their anchors identify. Nested records
link to their parent context. Relative links move with the prose. The old
ArrayBufferSink overview pointed to a nonexistent anchor; its new record owns
an explicit alias for that spelling.

The proof compares every generated record and rewritten crosslink byte for byte.
It makes no guest, native, API or upstream-pin changes. The original single-page history remains available with
`git log ad5716e5 -- docs/bun-patches.md`. The map and splitter identify each
record's original section; Git does not model a one-to-many file split as 143
independent renames.
