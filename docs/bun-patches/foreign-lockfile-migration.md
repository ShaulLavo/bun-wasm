## Foreign lockfile migration

Class **Host feature**. Original adapters in `crates/bunwasm-runtime/src/install/migration.rs`
and the shared writer in `install/mod.rs`. They use the existing Bun data parser,
workspace discovery and resolver. The adapters remain original host code. Registry
comparison, removal of URL authentication, external-transport integrity checks and
Berry optional-edge classification adapt the corresponding rules from Bun at
`5e0baa66516f3af00b008cdf1521c681317741e8`:

- `src/install/migration.rs` and `src/install/migration/npm_lock.rs` supply schema and source validation rules.
- `src/install/yarn_berry.rs` supplies registry precedence, registry identity checks and `dependenciesMeta` classification.
- `src/install/pnpm.rs` supplies importer and link-target validation rules.
- `src/install/lockfile/Tree.rs` supplies ancestor visibility and finite placement semantics.
- `src/install/integrity.rs` supplies the supported hash algorithms, strongest-digest selection and SRI padding used by the portable verifier.
- `src/install/npm.rs` and `src/install/NetworkTask.rs` supply configured Bearer/Basic authorization and registry-origin selection rules, checked against native Bun 1.4.2 for archives outside the metadata path.

The local implementation uses serde values and the portable filesystem rather than
Bun's package-manager graph. Unsupported selection rules fail before publication.
No vendor source or patch changes. The original request adapter now owns URL
normalization for migration and ordinary installation. It drops URL userinfo,
rejects transport queries, and keeps configured authorization out of URLs and lock
records. Host error text and optional warnings use the credential-aware redactor.
The lock writer checks decoded strings for embedded npm authentication and
configured secrets before publication. The original cache adapter uses the same
check before persistence or reuse and forwards the consumed unauthenticated
tarball response before best-effort Cache Storage publication. Its private stored
header preserves the final URL and redirect metadata through native cache cloning,
then restores the original headers before returning a hit. Native and TypeScript
host redirect adapters validate package destinations and remove sensitive headers on full-origin changes.
Host tracing prints metadata sizes rather than header values or payload text.
These redirect, trace and decoded-metadata guards are original adapters. The
portable verifier implements SHA-512, SHA-384, SHA-256 and SHA-1 and compares decoded
digests, including Bun's serialized padding for SHA-256 and SHA-384. Malformed
nonempty integrity rejects rather than weakening the input to an absent checksum.
The text format follows Bun's `src/install/lockfile/bun.lock.rs`; selected references
and bin representations are checked against native Bun rather than inferred from
pretty JSON. Registry metadata can fill omitted bin, platform and script fields,
while the original lock's checksum takes priority.

`tests/install/migration.ts` reads public fixtures and recorded metadata under
`vendor/bun/test/cli/install/migration/` at the Bun pin. It uses unchanged npm,
classic Yarn, Berry and pnpm fixtures, plus documented reductions and two small
snapshot-reference regressions. Files are copied only into owned test scratch.
No copied fixture or third-party implementation is checked into this change.
The replay combines the existing app-matrix cache and Bun's recorded
`registry/packages` and `yarn/npm-metadata.json`; its namespace has no external network route.

Logical install names stay separate from resolved package identities. pnpm's
full snapshot reference selects its edges before the peer context is removed
from serialized dependency values. Workspace roots and members seed traversal.
Git and direct tarball dependency protocols fail before any converted lock is
published. A valid classic Yarn resolved SHA-1 fragment becomes an SRI value.
The [validation notes](../lockfile-migration.md) distinguish exact native matches,
intentional fixes to older native behavior, and the pinned native canary used for strict Berry goldens.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Foreign lockfile migration](#foreign-lockfile-migration) | Host feature | Original format and credential-boundary adapters preserve selected records, workspace locations, optional edges and credential-free sources. |

[Ledger scope and pinned revisions](scope.md).
