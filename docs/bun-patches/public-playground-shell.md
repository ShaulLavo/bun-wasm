# Public playground shell

| Area | Classification | Source | Local change | Reason |
| --- | --- | --- | --- | --- |
| `web/src/playground/playground.ts` | Original Bun consumer adapter | Public `bash-web/session` entry at the exact bash-web revision pinned in the package manifests and shell builder | Pass the borrowed Waffle runtime, asset URLs, zsh editor option, terminal callbacks, and geometry to `BrowserSession.create` | Share the maintained session implementation instead of copying its input queue, bridge pump, or newline handling |
| `crates/bunwasm-host/src/slots.rs::add_shell_imports` | Original native shell ABI adapter | bash-web `src/runtime/guest-imports.ts` and `shell/engine/src/runtime_main.rs` at `d2b16d6fab8628e21e91b562ff96830b745b13cd` | Bind inherited native stdio, fixed 80x24 geometry, the two-argument phase/status notification, and the no-provider prompt imports (`prompt_names`, `prompt`, `prompt_update` return `-1`; `output_position` returns `0`) | The current shell must instantiate for native package scripts; prompt hooks are unavailable here and phase notifications do not own native process cancellation |
| `crates/bunwasm-host/src/process/mod.rs`, `slots.rs::add_import` | Original native process ABI adapter | Waffle `docs/host-abi.md` and `packages/waffle/browser/worker.ts` at `ea051e5e9061bcd2bfed6faf363be0f21d211acc` (`waffle-v0.0.100`, `programs-v0.0.8`) | Capture sorted launch descriptors and expose `runtime_proc.inherited_fd` with the specified `-ENOENT` terminator | The released env utility forwards real inherited descriptors to npm-bin shebang commands |
| Staged `env.wasm` | Host feature, unchanged upstream artifact | Waffle `packages/coreutils/dist/env.wasm`, `programs-v0.0.8`, source `ea051e5e9061bcd2bfed6faf363be0f21d211acc` | Copy to the native launcher guest path; no implementation changes | bash-web delegates external programs to the released Waffle families |

This replaces the playground's local command parser and line editor with
bash-web's real interactive shell. The page still owns exactly one Waffle runtime,
filesystem, base-program installation and Bun launchers. bash-web owns parsing,
line editing, job control and terminal inheritance. Waffle owns processes,
descriptors, stdin, signals and network services.

The page's welcome text reports filesystem storage and save durability from the
actual VFS persistence descriptor. This remains discoverable without redefining
Bash's `help`. The artifact-free editor gate replaces only engine/Shell execution
at build time; real runtime, filesystem, editor and page information code remain.

The playground imports `BrowserSession` from `bash-web/session`. The session owns
its bounded input queue, bridge pump, iOS output batching, and display newline
conversion. xterm remains the terminal view. Its output callback writes the final
bytes directly, without applying `TerminalNewlines` again. No local session copy
or upstream shell implementation remains in the consumer.

The page registers its Bun launcher for the selected engine and tools before
starting the session. Run calls `submit()` with an absolute editor path, so shell
`cd` does not change which file runs. The public session replaces the entire
edited draft with Ctrl+E, Ctrl+U, and Ctrl+K, including multiline zsh drafts.
The runtime and program tuple is recorded in `scripts/waffle-release-inputs.json`;
the shell builder uses the same exact bash-web revision as both applications.

The new shell revision delegates `env` to the published Waffle coreutils family.
`scripts/build-bash-web-shell.sh` builds only the shell and stages the matching
family `env.wasm`; the existing receipt still hashes both staged guests.
`scripts/waffle-release-inputs.json` records the published runtime/program
archives and unchanged libc builder/patch hashes for the selected tuple.

`BrowserSession.create()` waits for the first atomic prompt receipt, and
`submit()` waits for the next receipt and queued output handoff. The playground
uses `onState` and `running`; the session exposes `lastExit` and `lastPrompt`
without parsing prompt text or inferring status from child exits. bash-web owns input retries and bridge
output draining. xterm still parses writes asynchronously, so browser captures
await its write callback. Session disposal stops the shell but preserves the
borrowed page runtime.

The interactive shell starts during page setup, while the Bun launcher loads on
the first Bun child launch. The graph gate checks contributing bundle inputs
with normalized paths, requires that lazy launcher to be reachable from the page,
and keeps Bun execution and process-service implementations out of initial JS.

Waffle 0.0.106 at `d49714f8e4fb04cfcf47eb2a5b24cfbafdfe315a` re-exports
`CommandStdioError` from `packages/waffle/index.ts`. Its `proc/command.ts` has no
imports or executable setup, only interfaces, types and that inert error class.
The original startup classifier treats this exact module as data, while counting
its bytes. A maintained syntax check rejects added imports, static initialization
or other executable declarations. Both real app graphs must still defer the
command runner, command stdio, supervisor, registry and browser process broker.

An explicitly supplied Bash source path must already match the selected commit.
The producer rejects a mismatch without replacing that caller-owned checkout.

The merged Bash CI handoff supplies the exact source archive, runtime guest and
worker files. Its retained workers are copied unchanged; the page host bundles
the matching installed source. Consumer staging verifies the original native
checksum receipt before writing the app's guest receipt.

The native host supplies the same current terminal import signatures, including
`rows() -> i32` and `phase(i32, i32)`. Its fixed geometry extends the existing
80-column contract to 24 rows. Phase/status notifications are advisory on this
host; the shell's actual process exit reports status. The four prompt imports use
bash-web's canonical no-provider contract: `prompt_names`, `prompt` and
`prompt_update` return `-1`, while `output_position` returns `0`; native package
scripts do not start a prompt host. A compiled Wasm regression calls all four
prompt imports and the ready/running notifications with statuses 7, 130 and 0,
checks geometry, and confirms that notifications neither cancel the native process
nor change stdin.

The native process host supplies the released env utility's
`runtime_proc.inherited_fd(index: u32) -> i32` import. It snapshots launch
bindings in ascending descriptor order, excludes private preopens and returns
`-ENOENT` after the list ends. Later descriptor closes and allocations do not
change that snapshot. The real Wasm regression checks stdio and sparse launch
bindings, including the maximum signed descriptor, before and after those changes.
