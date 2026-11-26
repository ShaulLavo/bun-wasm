### Terminal colours

Native Bun colours `bun test` reports, matcher messages, diffs, uncaught errors and console values when the stream is a terminal. bun-wasm reproduces those bytes from Bun's own sources at the Bun pin.

- `crates/bunwasm-runtime/src/js/pretty_output.ts`. Class **Port**. Upstream `src/bun_core/output.rs` (`pretty_fmt_runtime`, `Source::set_init`, `is_no_color`, `get_force_color_depth`), `src/bun_core/env_var.rs` (`FORCE_COLOR`, `NO_COLOR`) and `src/bun_output_tags/lib.rs` (the tag table). Translates the `<tag>` to escape-sequence rewrite and the per-stream decision: a non-zero `FORCE_COLOR` colours both streams, a truthy `NO_COLOR` neither, otherwise each stream follows its own `isatty`. The template tag `markup` applies the rewrite to a template's literal parts only, as `pretty_fmt!` rewrites the format string before values are substituted. `Bun.enableANSIColors` reads it (`BunObject.rs`: either stream).
- `crates/bunwasm-runtime/src/js/js_highlight.ts`. Class **Port**. Upstream `src/bun_core/fmt.rs` (`QuickAndDirtyJavaScriptSyntaxHighlighter`). Translates the highlighter for source lines above an error, without the npm-secret redaction mode, which only `bun install` uses.
- `crates/bunwasm-runtime/src/print_diff.rs`. Class **Port**. A copy of `src/runtime/test_runner/diff/printDiff.rs` with no changes, linked against the vendored `bun_text_diff` crate. `crates/bunwasm-runtime/src/test_diff.rs` (an original adapter) exposes it as the `printDiff` native, which `bun_test.js` calls for coloured diffs. Uncoloured diffs keep the JavaScript port described in [Bun test diff formatting](bun-test-diff-formatting.md), so plain reports are unchanged.
- `crates/bunwasm-runtime/src/js/bun_test.js`, reporter and matcher messages. Class **Port**. Upstream `src/runtime/cli/test_command.rs` (`fmt_status_text_line`, `print_test_line`, the summary), `src/runtime/test_runner/jest.rs` (file header), `src/runtime/test_runner/bun_test.rs` (unhandled errors), `src/bun_core/output.rs` (`ElapsedFormatter`), `src/runtime/test_runner/expect.rs` (`get_signature`, `throw_pretty_matcher_error`) and `src/runtime/test_runner/expect/*.rs`. Each message keeps its existing plain text and carries the `<tag>` markup Bun's template has around the same values. Where the plain text already differed from Bun 1.4.5 (for example `toBeOneOf`, `toSatisfy`'s parameter name, `toHaveReturned`), the colours follow the nearest native template and the plain text is unchanged.
- `crates/bunwasm-runtime/src/js/inspect.js`, error printing. Class **Port**. Upstream `src/jsc/VirtualMachine.rs` (`print_error_instance_body`, `print_error_name_and_message`, `print_stack_trace`), `src/jsc/ZigStackFrame.rs` (`SourceURLFormatter`, `NameFormatter`) and `src/jsc/ConsoleObject.rs` (`ErrorDisplayLevelFormatter`). Adds the coloured code frame, caret, error label (plain for `console.log`, yellow for `console.warn`, red for `console.error`, uncaught errors and `bun test`), property list and stack frames.
- `crates/bunwasm-runtime/src/js/console.ts` and `bootstrap.js`. Original adapters: they pick the stream's colour decision as `ConsoleObject.rs` `message_with_type_and_level` and `format2` do (log, info, debug, dir and table on stdout; warn, error and assert on stderr; `console.error` lines wrapped in red unless they print one non-string value), colour `console.table` headers as `TablePrinter::print_table` does, and print the uncaught-error version line as `run_command.rs` does.

`tests/fixtures/test-colors` and `tests/fixtures/console-colors` compare the raw bytes with native Bun 1.4.5 under `FORCE_COLOR=1`.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/pretty_output.ts`](#terminal-colours) | Port | Translate Bun's colour decision and `<tag>` markup. |
| [`crates/bunwasm-runtime/src/js/js_highlight.ts`](#terminal-colours) | Port | Translate Bun's source-line highlighter. |
| [`crates/bunwasm-runtime/src/print_diff.rs`](#terminal-colours) | Port | Copy Bun's diff printer for coloured diffs. |
| [`crates/bunwasm-runtime/src/js/bun_test.js`, colours](#terminal-colours) | Port | Add Bun's reporter and matcher markup. |
| [`crates/bunwasm-runtime/src/js/inspect.js`, error colours](#terminal-colours) | Port | Translate Bun's coloured error printing. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
