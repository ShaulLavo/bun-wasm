# Scripts from stdin

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-cli/src/main.rs`, `crates/bunwasm-runtime/src/lib.rs`, `modules.rs`, `src/js/bootstrap.js` | Original adapter | Observable `bun run -` behavior from Bun 1.4.4 and `src/runtime/cli/run_command.rs` at `9510e74152073d850a18758ca41114d8f214ffa6` |

No upstream implementation is copied. The CLI accepts the exact `-` operand after
`run`. Other leading-dash operands still use the existing flag parser. Once the
entry is selected, later arguments pass through unchanged.

The runtime gives stdin the synthetic `<cwd>/[stdin]` module path and keeps `-`
in `process.argv[1]`. The module loader reads the pipe through Rust's streaming
reader, then uses the normal TypeScript transpiler and module classification.
It caches the source so repeated module-source requests do not read the pipe again.
The main-module dispatcher skips package-script lookup and filesystem existence
checks for stdin. A package script named `-` or a file named `[stdin]` cannot
replace the piped source. Relative imports resolve from the working directory.

`scripts/stdin-script-cli.test.ts` compiles the production parser and checks the
sentinel, passthrough arguments, conditions, help, missing operands and unknown
flags. `tests/fixtures/stdin-script` checks actual execution, TypeScript, imports,
await, argv, main metadata and consumed stdin. `web/tests/browser-stdin-script.ts`
uses the maintained shell-product host and its real bash-web shell, Waffle pipes,
and Bun CLI guest. It also checks empty input, thrown errors and prompt recovery.
