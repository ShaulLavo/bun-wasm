# bun repl and node:repl

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/node_repl.ts` evaluation: Bun's transpiler in `replMode`, `{ value }` unwrapping, awaiting async results, `_` and `_error`, dot commands | Adapted upstream implementation | Bun `src/runtime/cli/repl.rs` (`evaluate_and_print`, `ReplCommand::ALL`) at `9510e74152073d850a18758ca41114d8f214ffa6`, SHA-256 `e021483fb134269cd678eb21e828f4a6fd2413b219beb9b51124354b5a29fc43` |
| `node_repl.ts` line editor, `REPLServer`/`start()` surface, piped-input mode | Original adapter | None |
| `crates/bunwasm-cli/src/main.rs` `bun repl` banner and lifetime | Adapted upstream text | Bun `repl.rs` banner |

`node:repl` was an unsupported stub. It now provides `start()` and `REPLServer` (with `defineCommand`, `displayPrompt`, `clearBufferedCommand`, `close` and the `exit` event) on top of the same evaluation as native `bun repl`: input goes through `Bun.Transpiler({ loader: "tsx", replMode: true })`, so declarations persist, TypeScript works and top-level `await` resolves before printing. Unterminated input ("end of file" parse errors) continues on a `...` line. Dot commands are `.help`, `.exit`, `.clear`, `.break`, `.history`, `.load` and `.save`; `.copy` and `.editor` are left out.

The browser terminal leaves echo to the program, so the original editor echoes and redraws its line and handles history, cursor keys, Ctrl+A/E/U/K/L, Ctrl+C (clear, then exit on a second press) and Ctrl+D. When standard input is not a terminal, lines are evaluated in order with no banner or prompts, and the REPL exits at end of input.

Interactive use from bash-web waits on Waffle: a Bun process started by the shell currently reads end-of-file from terminal standard input. Piped input works and is what the `bun-repl` browser stage checks.
