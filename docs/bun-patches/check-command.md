## Check command

Class **Port**. Bun revision `a7733435cf40429e3b35c36072769df2052b80f1`.

`bun check` runs Bun's TypeScript type checker (`src/sema`, through `src/sema/driver`)
in `dist/bun-tools.wasm`, the on-demand guest that already holds `bun lint` and
`bun fmt` ([Lint and format commands](lint-and-format-commands.md)). The default
engines don't link the checker.

The host picks the tools guest with one prefix rule: `crates/bunwasm-cli/src/tool_args.rs`
for the native host, the CLI and the tools entry point, and its mirror
`web/src/tool-command.ts` for the browser and Node hosts. It follows upstream
`src/runtime/cli/script_or_command.rs::place_of_first_word`: Bun's global flags
that take a value (the `<VALUE>` entries of `AUTO_PARAMS` in
`src/runtime/cli/Arguments.rs`, listed by hand) consume the next argument, so
`bun --title check ./entry.ts` runs `entry.ts`; `-e` and `-p` evaluate, except
that `-p…` directly before `check` is its `--project`; and an executable named
`node` or `nodejs` has no subcommands. What follows `--` is the command or the file
to run, so `bun -- --entry.ts check` runs `--entry.ts`. A bare `-` runs standard input, so `bun - check` passes it
`check`; the CLI now does this for `bun -` as it did for `bun run -`. Of the flags
before `check`, the checker gets the options that upstream's check command parses
anywhere on the command line, when they fit in one argument: a short-flag chain directly before
it, without Bun's `b` (`-bhpapp` reaches the checker as `-hpapp`), so the checker's
parser accepts or rejects it as upstream's parses the whole command line, `--project=…`,
`--tsconfig-override` in either form, `--threads=…`, `--no-pretty`, `--all`,
`--timing`, `--no-script`, `--no-emit`, `-h` and `--help`. Bun's other flags there,
such as `--title=check` or `--no-warnings`, stay Bun's, and `-b`/`--build` there are
`--bun`, as upstream. `bun lint` and
`bun fmt` still get the flags before them that Bun doesn't know. The rule does not ask the lint and format
drivers which short flags they accept before the command, as upstream's
`has_flag` does. The package's `installBunAdapters` takes an optional `loadTools`
and passes it to the launchers, as the playground does.

`crates/bunwasm-tools/src/check_command.rs` adapts upstream
`src/runtime/cli/check_command.rs`:

- `Request`, `Provided { ends_the_process: true }`, `print_report` and `style_for`
  follow upstream. Diagnostics go to stdout and the summary to stderr, and the
  exit code is 1 when the report has errors.
- Short-flag chains follow clap's precedence: an invalid letter or a `-p` without
  a value is an error even after `-h`, and `-h` wins over unknown long flags and
  compiler options, which are checked later.
- Arguments are parsed by hand instead of with `bun_clap`'s compile-time tables,
  in two steps like upstream: first `bun check`'s own options (`-p`/`--project`
  and its alias `--tsconfig-override`, with the last one winning, attached forms
  such as `-papp`, an empty value (`-p=`, `--project=`) meaning the working directory's project and,
  like any project given on the command line, replacing one from a response file, `-b`/`--build`, `--no-pretty`, `--all`, `--timing`, `--cwd`,
  `--threads`, `--no-emit`, `--no-script`, `-h`/`--help` and `--`), then
  `--cwd`, then `bun_sema_driver::parse_command_line` for the compiler options
  and response files, in the new working directory.
- The check runs on the calling thread
  (`bun_sema_driver::run_regions_inline_on_this_thread`) with `threads: 1`,
  because WASI preview 1 has no threads. `--threads` is validated and ignored.
  No progress line is shown, since it needs a second thread.
- The help is upstream's (`Tag::CheckCommand` in `src/runtime/cli/mod.rs`) without
  colors. It drops "using all CPU cores" and the `bun --check` example, and says
  that `--threads` and `--no-script` are accepted and have no effect.
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

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Check command adapter](#check-command) | Port | Run Bun's type checker as `bun check` in the tools guest, single-threaded. |

[Ledger scope and pinned revisions](scope.md).
