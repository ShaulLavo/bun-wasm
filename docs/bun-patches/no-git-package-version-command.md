## No-git package version command

Class **Port**. `crates/bunwasm-runtime/src/install/version.rs`
adapts validation, diagnostics and stable-version increments from
`src/cli/pm_version_command.rs` at Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`, with local patched source at
`d71508d31edf06765c12adf0df137ef531539f68`.
It uses Bun's complete-version parser and the upstream JavaScript safe-integer
limit. The local command has its own argument dispatch before install options,
then validates the request and current bump version before any manifest write.
Specific versions are normalized without build metadata, matching native Bun
1.4.4 controls. Existing atomic installer writes publish the changed manifest.

The bounded adapter supports patch, minor, major and specific versions with
`--no-git-tag-version`, plus `--allow-same-version`, `--dry-run` and
`--ignore-scripts`. Prerelease increments, Git operations and lifecycle execution
are explicitly unsupported. A lifecycle declaration fails before writing unless
scripts are ignored. It does not install packages or change lockfiles.
The local fixture tests include native Bun controls and exact invalid-version
messages with byte-for-byte preservation of failed manifests.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [No-git package version command](#no-git-package-version-command) | Port | Adapt Bun version validation and stable-version increments to the portable no-git command. |

[Ledger scope and pinned revisions](scope.md).
