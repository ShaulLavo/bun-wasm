# Public playground shell

| Area | Classification | Source | Local change | Reason |
| --- | --- | --- | --- | --- |
| `web/src/shell.ts`, `web/src/main.ts` | Original Bun consumer adapter | bash-web public shell/bridge API at `0bf41ec6d7f149c77ec2ad00a97b5b9928b4a2e0 (merged PR176; CI run 40886275313)`; existing private playground `src/session.ts` and `src/main.ts` integration | Connect xterm input, resize, output, signals and shell state to the page-owned Waffle runtime | Bun REPL and child processes need a live terminal instead of output-only runs |
| `crates/bunwasm-host/src/slots.rs::add_shell_imports` | Original native shell ABI adapter | bash-web `shell_terminal` imports at the same merged source | Bind rows and the two-argument phase/status notification to inherited native stdio with fixed 80x24 geometry | The current shell must instantiate for native package scripts; phase notifications do not own native process cancellation |
| Staged `env.wasm` | Host feature, unchanged upstream artifact | Waffle `packages/coreutils/dist/env.wasm`, `programs-v0.0.7`, source `63ddc5da0699d6e3ca449eaecb0bc35069c664d9` | Copy to the native launcher guest path; no implementation changes | bash-web delegates external programs to the released Waffle families |

This replaces the playground's local command parser and line editor with
bash-web's real interactive shell. The page still owns exactly one Waffle runtime,
filesystem, base-program installation and Bun launchers. bash-web owns parsing,
line editing, job control and terminal inheritance. Waffle owns processes,
descriptors, stdin, signals and network services.

The session follows the existing private playground's bridge pump and bounded
input queue. xterm stays the public playground's terminal. `TerminalNewlines`
comes from bash-web. No upstream shell or OS implementation is copied or patched.
The page registers its existing Bun launcher for the selected engine and tools
before starting the shell. The Run button submits an absolute editor path so
shell `cd` does not change which file it runs.

The earlier bash-web pin sent `shellTerminal` and `terminalAdmission`, while
Bun accepts `terminalContext` and `terminalInput`. This consumer pins
the prompt-status API, Waffle 0.0.100 and base-program 0.0.8 tuple together. The shell guest
builder uses the same shell revision as both browser applications.

The new shell revision delegates `env` to the published Waffle coreutils family.
`scripts/build-bash-web-shell.sh` builds only the shell and stages the matching
family `env.wasm`; the existing receipt still hashes both staged guests.
`scripts/waffle-release-inputs.json` records the published runtime/program
archives and unchanged libc builder/patch hashes for the selected tuple.

The consumer awaits bash-web's authoritative `waitForPrompt()` receipt for
startup and each serialized host submission. Receipt generations make a prompt
published before the waiter safe. Status comes from the shell, including builtins;
there is no prompt parsing, injected status command or child-exit inference.
Normal terminal input and accepted-prefix retries carry the command and Enter.
Before publishing readiness or resolving a submission, the consumer drains the
bridge's available output into the terminal view. The prompt receipt alone does
not acknowledge that page-side handoff; captures still await xterm's write callback.

The interactive shell starts during page setup, while the Bun launcher loads on
the first Bun child launch. The graph gate checks contributing bundle inputs
with normalized paths, requires that lazy launcher to be reachable from the page,
and keeps Bun execution and process-service implementations out of initial JS.

An explicitly supplied Bash source path must already match the selected commit.
The producer rejects a mismatch without replacing that caller-owned checkout.

The merged Bash CI handoff supplies the exact source archive, runtime guest and
worker files. Its retained workers are copied unchanged; the page host bundles
the matching installed source. Consumer staging verifies the original native
checksum receipt before writing the app's guest receipt.

The native host supplies the same current terminal import signatures, including
`rows() -> i32` and `phase(i32, i32)`. Its fixed geometry extends the existing
80-column contract to 24 rows. Phase/status notifications are advisory on this
host; the shell's actual process exit reports status. A compiled Wasm regression
calls ready/running notifications with statuses 7, 130 and 0, checks geometry and
confirms that notifications neither cancel the native process nor change stdin.
