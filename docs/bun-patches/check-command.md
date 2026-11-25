## Check command

Class **Port**. Bun revision `a7733435cf40429e3b35c36072769df2052b80f1`.

`bun check` runs Bun's TypeScript type checker (`src/sema`, through `src/sema/driver`)
in `dist/bun-tools.wasm`, the on-demand guest that already holds `bun lint` and
`bun fmt` ([Lint and format commands](lint-and-format-commands.md)). The default
engines don't link the checker. The host routes the command to the tools guest
with the same prefix rule as lint and format: `crates/bunwasm-cli/src/tool_args.rs`
for the native host and the tools entry point, `web/src/tool-command.ts` for the
browser and Node hosts.

`crates/bunwasm-tools/src/check_command.rs` adapts upstream
`src/cli/check_command.rs`:

- `Request`, `Provided { ends_the_process: true }`, `print_report` and `style_for`
  follow upstream. Diagnostics go to stdout and the summary to stderr, and the
  exit code is 1 when the report has errors.
- Arguments are parsed by hand instead of with `bun_clap`'s compile-time tables.
  The adapter takes `--no-pretty`, `--all`, `--timing`, `--cwd`, `--threads`,
  `--tsconfig-override`, `--no-emit`, `--no-script`, `-h`/`--help` and `--`,
  and passes everything else to `bun_sema_driver::parse_command_line`, which
  handles `-p`/`--project`, `-b`/`--build`, `--pretty` and the compiler options,
  as upstream does.
- The check runs on the calling thread
  (`bun_sema_driver::run_regions_inline_on_this_thread`) with `threads: 1`,
  because WASI preview 1 has no threads. `--threads` is validated and ignored.
  No progress line is shown, since it needs a second thread.
- The terminal width is 0 (unknown); the host terminal wraps.
- A `check` script in `package.json` is not run in place of the checker
  (upstream `script_or_command.rs`), the same as for `bun lint` and `bun fmt`
  here. `--no-script` is accepted.
- HTML pages are not scanned for their scripts (`with_pages`), and the canary-only
  `--run-typescript-tests` is not included.
- `bun run --check`, `bun test --check` and `bun build --check` are not wired:
  the default engines don't link the checker.

`src/runtime/cli/typescript_libs.rs` and its `typescript_libs.bin` are compiled once
in `crates/bunwasm-tools/src/main.rs` and shared by the lint and check adapters.

## ICU normalization

Class **Port**. `crates/bunwasm-lint-native/src/lib.rs` defines `Bun__normalizeUTF16`,
the C entry point of upstream `src/jsc/bindings/bun_icu_normalize.cpp`, on the
`icu_normalizer` crate (ICU4X) instead of ICU4C's `unorm2_normalize`, which the
tools guest doesn't link. It keeps the same contract: forms 0 to 3 are NFC, NFD,
NFKC and NFKD, the return value is the normalized length, and the text is written
only when it fits. Bun 1.4.5's JSON lint rule `no-unnormalized-keys` is its only
caller in the tools guest. ICU4X maps unpaired surrogates to U+FFFD before
normalizing, where ICU4C keeps them.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Check command adapter](#check-command) | Port | Run Bun's type checker as `bun check` in the tools guest, single-threaded. |
| [ICU normalization](#icu-normalization) | Port | `Bun__normalizeUTF16` on ICU4X for the tools guest. |

[Ledger scope and pinned revisions](scope.md).
