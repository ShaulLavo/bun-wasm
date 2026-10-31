### Build command

`crates/bunwasm-build/src/lib.rs` and its `BuildArgs` model in `src/args.rs`. Class **Port**. Upstream `src/runtime/cli/build_command.rs` and build-option definitions in `src/runtime/cli/Arguments.rs` at Bun revision `9510e74152073d850a18758ca41114d8f214ffa6`.

Retain the option setup, `BundleV2::generate_from_cli` flow, output writing, and summary formatting. Replace the JSC command context with `BuildArgs` and returned `BuildOutput` values. Printing and process exit belong to the caller. Omit native executable compilation, bytecode, app mode, server components, check/watch modes, macros, and plugins. This extraction lets WASI call the real bundler without linking Bun's JSC runtime. The local CLI parser is an original adapter, not a copy of the upstream argument parser.

## Original command adapters

Class **Host feature**. `crates/bunwasm-build/src/args.rs` owns the local flag
parser and usage model. `src/cli.rs` owns command output and status handling.
Both `src/bin/bun-build.rs` and `crates/bunwasm-cli/src/build_command.rs` call
that shared implementation. The standalone command now accepts
`--react-fast-refresh`, matching `bun build`.

The option model moved without changing its fields or defaults. The parser
retains argument consumption, immediate `--cwd` changes, help ordering, and
error wording. These are original adapter changes. They do not add an upstream
patch or copy Bun's argument-parser implementation.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-build/src/lib.rs`, `src/args.rs`](#build-command) | Port | Extract Bun's build command and option model from its JSC runtime. |
| [`crates/bunwasm-build/src/args.rs`, `src/cli.rs` and both command entrypoints](#original-command-adapters) | Host feature | Share the original command adapter without copying Bun's argument parser. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
