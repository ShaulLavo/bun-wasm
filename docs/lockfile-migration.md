# Foreign lockfile migration

Status: Approved.

This change depends on PR #68's workspace/local dependency graph and lock metadata.
It is a separate PR so the command and workspace gains can land first.

The installer imports `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` when
`bun.lock` is absent. `bun pm migrate` converts without extracting packages.
Imported and newly resolved locks use the same text writer. A migrated project
can immediately perform an unchanged frozen installation, including a foreign
lock passed directly to `install --frozen-lockfile --lockfile-only`.

Migration keeps logical aliases separate from resolved package names. pnpm
snapshot references retain their complete peer context during traversal. The
root and every declared workspace contribute their selected edges. Root
metadata omits the project version; member versions and dependency pins remain.
Registry URLs and integrity values stay attached to their selected packages.
Missing bin/platform/script metadata can come from the configured registry,
with the lock's existing checksum taking priority.

Git and direct URL/tarball dependency protocols are currently rejected without
writing a converted lock. Their identities are not rewritten as registry
packages. A registry package's explicit HTTP tarball transport remains intact.
Local workspace references use the workspace graph from PR #68.

## Native reference checks

`tests/install/migration.ts` compares complete native and guest `bun.lock` bytes.
It then checks direct frozen foreign-lock installation, a frozen reinstall, and
native frozen acceptance of the converted lock. The genuinely empty pnpm case
checks the exact native migration bytes and guest frozen behavior; native Bun
1.4.2 rejects its own empty migrated lock during frozen installation.

The public fixtures come from Bun's `test/cli/install/migration/` directory:

- npm `npm-arborist/dep-installed-without-bin-link`.
- Classic Yarn `yarn/yarn-lock-mkdirp`.
- pnpm `basic`, `v9-alias-in-optional-dependencies`, `v9-reference-shapes`,
  `v9-peer-range-dedupe`, and `v9-importer-peers`.
- Berry `yarn-berry/basic` and `yarn-berry/workspaces`.

Derived cases remove unrelated protocols from the scoped-alias fixture, move
an existing classic dependency into a member, isolate workspace-only pins,
remove an explicit integrity field to expose its existing SHA-1 fragment, and
reduce the public Git/HTTP fixture to one selected source. Two additional
minimal cases exercise the same snapshot schema with one and two peer contexts.
An empty lock is derived from the public pnpm schema. These reductions are
applied equally to the native and guest inputs.

All test networking stays inside a private loopback namespace. The server
replays `/work/cache/bun-wasm-app-matrix` and Bun's existing
`registry/packages` records plus `yarn/npm-metadata.json`. It never records or fetches live registry data.
Checksum rejection uses an unrelated archive already present in that recording.

Native Bun 1.4.2 has two intentional migration differences. It loses a classic
SHA-1-only checksum, and its classic `pm migrate` omits workspace-only members.
This adapter preserves both. The native byte diffs are retained, and native
frozen installation accepts the completed workspace lock without rewriting it.
The SHA-1 case also rejects a corrupt replayed archive.

Stable native Bun 1.4.2 and 1.4.3 reject Berry input with
`UnsupportedYarnLockfileVersion`. Strict comparisons use the official native
Bun `1.4.4-canary.1+5f5799ed1`, selected through `NATIVE_BUN`. Its official
archive was verified against GitHub's SHA-256 asset digest before use.
No format-only or unsupported-reference bypass is used by the final checks.
The native tool is isolated from the global Bun installation and removed after
verification.

Run the check inside the heavy wrapper, after building the selected wasm engine:

```sh
NATIVE_BUN=/path/to/native-bun-with-Berry-support \
INSTALL_ENGINE=quickjs BUN_WASM=dist/bun.wasm \
BUN_WASM_LAUNCHER=/path/to/bun-wasm \
unshare --user --map-root-user --net bash -c 'ip link set lo up; exec "$@"' _ \
  bun tests/install/migration.ts
```

Repeat for `jsc` and `browser`. `MIGRATION_EVIDENCE` retains native/guest locks
and diagnostics. `MIGRATION_CASES` selects comma-separated fixture names.
`NATIVE_BUN` selects an existing native reference binary. Every child, namespace,
replay listener and scratch copy is owned by the test and removed at teardown.
