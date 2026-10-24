### Build command

`crates/bunwasm-build/src/lib.rs`. Class **Port**. Upstream `src/runtime/cli/build_command.rs` and build-option definitions in `src/runtime/cli/Arguments.rs` at the Bun pin.

Retain the option setup, `BundleV2::generate_from_cli` flow, output writing, and summary formatting. Replace the JSC command context with `BuildArgs` and returned `BuildOutput` values. Printing and process exit belong to the caller. Omit native executable compilation, bytecode, app mode, server components, check/watch modes, macros, and plugins. This extraction lets WASI call the real bundler without linking Bun's JSC runtime. The local CLI parsers around it are adapters, not copies of the whole upstream argument parser.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-build/src/lib.rs`](#build-command) | Port | Extract Bun's build command from its JSC runtime. |

[Parent context](bun-patch-series.md).
