# Bun.$ and bun exec on the system shell

| Local source | Classification | Upstream source |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/bun_shell.ts`: `ShellPromise`, `ShellOutput`, `ShellError`, `Shell` and the `$` template function | Adapted upstream implementation | Bun `src/js/builtins/shell.ts` at `9510e74152073d850a18758ca41114d8f214ffa6`, SHA-256 `90e309e117b8abcc758beb9704345eacb7aab9803755dd28f1c5dbe80dfddbfe` |
| `bun_shell.ts` escaping (`$.escape` and interpolated words) | Adapted upstream implementation | Bun `src/shell_parser/parse.rs` (`SPECIAL_CHARS`, `needs_escape_utf8_ascii_latin1`, `escape_8bit`) at the same revision, SHA-256 `baf3418aa3127c5323bf213dfad3c46c177acacdec260a48e9e1bc967dc95e6c` |
| `bun_shell.ts` `findShell`: `bash`, then `sh`, on `PATH` | Adapted upstream implementation | Bun `src/runtime/cli/run_command.rs` `find_shell_impl` at the same revision, SHA-256 `d2da381fc17ee55bb18e3667060f978d4df1e8891fe78026ab0d4c51cd380f5f` |
| `bun_shell.ts` interpreter (`sh -c`), JS-object redirects through temporary files, `$.braces` | Original adapter | None |
| `crates/bunwasm-cli/src/main.rs` `bun exec` | Original adapter | Bun's `exec_command.rs` behavior: one script argument, exit with its status |

Native Bun runs `$` templates in its own shell interpreter. In bun-wasm the interpreter is the page's system shell, bash-web, which bash-web's `installShellCommands` registers at `/bin/sh` and `/bin/bash`. The promise, output and error classes are upstream's, with the generated `ParsedShellScript` and `ShellInterpreter` classes replaced by a small script object and a `sh -c` spawn. Interpolated values are escaped exactly as Bun escapes them (double quotes, backslashes before `` $ ` " \ ``), so they stay single words in bash. Arrays become one word per item and `{ raw }` is inserted as written. A `Response`, `Blob`, `ArrayBuffer`, typed array or `ReadableStream` after `<` is written to a temporary file that the command reads; a typed array after `>` receives the command's output. `Bun.file()` becomes its path. Output is echoed and captured unless `.quiet()` is set, as in Bun.

`$.braces` expands nested comma lists and leaves `{1..3}` sequences alone, which is what native Bun 1.4.4 returns. Bun's interpreter builtins (`ls`, `rm`, `which` and so on) are not part of this layer: commands are whatever programs the page registered.

`bun exec <script>` runs the script with `sh -c` and inherited standard streams, and exits with its status.

`scripts/bun-shell.test.ts` loads the real module over the host's bash and compares escaping, brace expansion and 25 command cases (including interpolation inside double and single quotes and the `.env()` snapshot) with native `Bun.$`. Redirect files live in a private `mkdtemp` directory created when the command runs and removed afterwards, so a failed redirect leaves nothing and never touches other files. The browser proof is the `bun-shell` mode of `web/tests/browser-shell-product.ts`.
