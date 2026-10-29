# Public playground shell

| Area | Classification | Source | Local change | Reason |
| --- | --- | --- | --- | --- |
| `web/src/shell.ts`, `web/src/main.ts` | Original Bun consumer adapter | bash-web public shell/bridge API at `18cb6af0e5fbbddad5b62843c04a1256e6a1c7a3`; existing private playground `src/session.ts` and `src/main.ts` integration | Connect xterm input, resize, output, signals and shell state to the page-owned Waffle runtime | Bun REPL and child processes need a live terminal instead of output-only runs |

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
