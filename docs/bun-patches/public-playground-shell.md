# Public playground shell

| Area | Classification | Source | Local change | Reason |
| --- | --- | --- | --- | --- |
| `web/src/shell.ts`, `web/src/main.ts` | Original Bun consumer adapter | bash-web public shell/bridge API at `72c18745d536df42edf0555f22c10c73a0a837d9`; existing private playground `src/session.ts` and `src/main.ts` integration | Connect xterm input, resize, output, signals and shell state to the page-owned Waffle runtime | Bun REPL and child processes need a live terminal instead of output-only runs |
| Staged `env.wasm` | Host feature, unchanged upstream artifact | Waffle `packages/coreutils/dist/env.wasm`, `programs-v0.0.6`, source `066c17936f6db39a92ec5ced0201e9f01106eea7` | Copy to the native launcher guest path; no implementation changes | bash-web delegates external programs to the released Waffle families |

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
Bun accepts `terminalContext` and `terminalInput`. This consumer pins the accepted
Bash72, Waffle 0.0.98 and base-program 0.0.6 tuple together. The shell guest
builder uses the same shell revision as both browser applications.

The new shell revision delegates `env` to the published Waffle coreutils family.
`scripts/build-bash-web-shell.sh` builds only the shell and stages the matching
family `env.wasm`; the existing receipt still hashes both staged guests.
`scripts/waffle-release-inputs.json` records the published runtime/program
archives and unchanged libc builder/patch hashes for the selected tuple.

The adapter prefixes the prompt with the standard OSC 133 A marker. Startup
waits for the first real prompt, and host `submit()` completes only after the
next prompt. Shared phase observations alone can miss an entire fast command
or observe an empty input ring before execution starts. This tracks terminal
prompt boundaries without parsing shell commands.

Prompt redraws during editing do not complete a submission. The consumer first
observes the submitted line ending, then the next prompt marker. Host submission
uses ordinary End and kill-line keys to replace an unfinished draft.
