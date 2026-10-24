## Lint process environment

Class **Host feature**, **original adapters** in
`crates/bunwasm-tools/src/lint_command.rs`,
`crates/bunwasm-tools/src/configuration_process.rs` (with the original test host
`configuration_process_test_host.rs`), and `crates/bunwasm-host/src/process/`.
These adapters implement Waffle's generic `runtime_proc` contract; no upstream
process implementation is copied.

The driver supplies Bun's existing config-evaluation programs as source parts.
The adapter runs them in a fresh instance of the selected engine executable,
passing the requested cwd and filtered process environment. It uses ordinary
`runtime_proc` spawn, pipe, read, poll, wait and signal operations. The child's
job is the caller's `job_of(0)`; a missing job fails instead of choosing a fallback.
The selected engine's leading PATH entry determines its canonical executable
path. It drains both output pipes while waiting and closes owned descriptors on
every return path. It invokes no host executable or model provider.

Bun serializes these evaluations with the guard in its pinned
`src/runtime/cli/lint_command.rs::run_and_exit` and starts an isolated process
with `--no-orphans`. The WASI callback is synchronous, but each evaluation is an
ordinary child occupying the same process directory as other children. The
`purpose: "configuration"` metadata is descriptive only: there is no separate
Bun-only admission pool or helper reservation. Completed children retain their
process-directory slot until consuming wait, which releases it.

Pinned Bun does not impose a time or output limit here. The wasm adapter adds
a five-second elapsed-time limit and an eight-MiB combined stdout/stderr budget
for the memory-limited host. It kills, reaps, and closes the child and its pipes
on either refusal, returning the error through the driver's existing config
diagnostic path. Host spawn errors retain their code and message, including
EAGAIN, instead of being reported as missing subprocess support.


The original `src/js/bun_plugin.ts` adapter implements synchronous runtime
`Bun.plugin` setup and the `build.module(name, factory)` object loader used by
Bun's config programs. Resolver aliases point to unique builtin-module keys,
so ESM and CommonJS share the same lazily created exports object on every
engine. Clearing registrations removes future resolution without reusing keys.
No upstream plugin implementation is copied. Other runtime plugin hooks and
async setup are not implemented.



## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Lint process environment](#lint-process-environment) | Host feature | Original `configuration_process.rs` adapter and test host run ordinary runtime_proc children with bounded time/output; runtime adapters register object modules. |
