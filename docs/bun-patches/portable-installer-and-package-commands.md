## Portable installer and package commands

Class **Host feature**. Original adapters in `crates/bunwasm-runtime/src/install/`,
`src/js/package_scripts.ts`, and `crates/bunwasm-cli/src/main.rs`. No upstream
source is copied or changed by these adapters, apart from the version adaptation
listed above. They use Bun's `src/glob/` walker,
`src/semver/` parser, and the existing transpiler data parser from revision
`9510e74152073d850a18758ca41114d8f214ffa6`.

The installer checks `Group::has_skipped()` from Bun's
`src/semver/SemverQuery.rs` before matching a registry range. The parser reports
allocation errors through its result and records unrecognised tokens separately.
A dist tag such as `latest` must reach tag resolution instead of matching a locked
version as a wildcard.

The manifest Accept value follows Bun's registry request contract, also checked
by `test/cli/install/dummy.registry.ts` at that revision. Cache refresh uses the
Cache-Control header, so it does not change content negotiation.

Workspace discovery reads declared member manifests, resolves local dependencies
relative to their declaring package, and creates filesystem links. The native
installer retains its hoisted graph and tarball validation. Foreign lockfile
migration is kept in a separate follow-up PR using this workspace graph.

`bun update` resolves selected dependencies again, within their declared ranges
unless `--latest` is supplied. Selected member updates clear their nested
resolution pins before resolving the workspace graph. `bun x` prefers a local binary and otherwise
installs into an atomically published cache directory. Concurrent cold installs
have separate staging directories. Download cache writes also use unique temporary
files and publish complete bytes through an atomic rename. Installed binaries use relative links so a
published cache directory remains movable. Only ENOTSUP and EPERM from bin-link
creation degrade to a warning; preparation failures and other errno values
remain fatal. Required workspace links retain their original failure behavior.
When a bin link is absent, the command adapters select the real installed entry
through its package manifest, including scoped packages. These are original
adapter changes, with no additional upstream source or patch. The playground
shell dispatches its `bunx` alias through the same `bun x` command path.

Default bunx bin-map selection follows Bun's first-valid-entry behavior in
`src/runtime/cli/bunx_command.rs`, `get_bin_name_from_subpath`, at the Bun pin.
Explicit bin names require an exact match. The host-engine import-meta hook
reads the resolved main path after script expansion, matching the embedded engines. The local adapter preserves published
cache use under `--no-install`. Member updates invalidate only the member's
selected lock entries, leaving unrelated root pins intact.

The package-script PATH adapter keeps the caller's explicit PATH, including an
empty value. Only a missing PATH receives `/bin:/usr/bin`, matching the runtime's
existing executable-search default. Ancestor package bins still precede it.
This is an original adapter change. Native Bun controls preserve the explicit
suffix but additionally inject a temporary Node proxy. The portable adapter does
not inject that proxy and keeps deliberately restricted guest paths restricted.
This repairs the immediate Node ENOENT branch measured in the Vite worker. It
does not establish successful Vite dependency optimization; the explicit-PATH
control still exceeded the unchanged 90-second deadline.

The TypeScript package-script dispatcher runs JavaScript and TypeScript binaries
inside the selected engine. It handles quoted arguments and environment
assignments. Runtime entries preserve source-file precedence. Bare executables
expanded from package scripts use installed bins and PATH; explicit relative
paths address the file directly. Manifest bin fallback applies the installer's
target validation and silently skips malformed entries before continuing to
other packages. Host native Bun controls and rebuilt engine/page regressions
cover command collisions and malformed declarations. These are original adapter
changes rather than a copied shell implementation.
Shell pipelines, redirections, command substitution, and native
executables remain outside this adapter. Install lifecycle scripts and security
scanner execution retain their existing limitations.

`tests/fixtures/installer-gaps/` uses an in-process fixture registry and synthetic
tarballs. It checks the header, workspace imports, a frozen reinstall, binary
links, script argument forwarding, update ranges and `bun x`
without public-registry access.

The original `node-misc` fixture checks current process-provider failure paths.
It requires a structured `ENOENT` or `ERR_NOT_SUPPORTED_IN_WASM` error when
admission fails, or status 127 with the missing-program diagnostic when the host
completes an unregistered program. Both asynchronous completion and synchronous
failure are checked. Its source is TypeScript. The spawn-facade unit harness loads
the real TypeScript command dispatcher with an explicitly empty filesystem.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Portable installer and package command adapters](#portable-installer-and-package-commands) | Host feature | Original filesystem, lockfile and command adapters over Bun's matcher, parsers and semver. |

[Ledger scope and pinned revisions](scope.md).

Package scripts retain runtime executable arguments instead of treating CLI
subcommands and flag operands as module names. The original package-script
adapter delegates these invocations through the existing `spawn` module and
`runtime_proc` descriptors to the selected executable's CLI. It inherits stdio,
cwd and the script environment and reports the child exit status. Only actual
Bun script aliases expand locally; visited names detect alias cycles without
limiting acyclic chains. Reserved CLI names remain commands unless preceded by
`bun run`. Node and nodejs CLI entrypoints treat bare operands as file paths,
not Bun subcommands or package scripts. This changes no process implementation
and copies no additional upstream source. The reference remains Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`.

`scripts/package-scripts-dispatch.test.ts` exercises the emitted adapter and
runMain dispatch with real temporary files and native Bun/Node references.
`scripts/package-script-cli.test.ts` compiles the actual CLI parser in isolation.
`tests/fixtures/package-script-dispatch/` is the compiled-guest regression for
runtime commands, flags, argument forwarding, environment, file precedence and
exit status. Source controls are not evidence of rebuilt guest acceptance.
