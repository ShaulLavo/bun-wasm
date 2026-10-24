## Process startup and executable identity

Class **Host feature**, original guest, browser, native and Node adapters; no
upstream implementation is copied. Async spawn observes nonconsuming startup
status before every consuming wait, including kill probes, and keeps a pending
startup record alive until entry or startup failure is decided. Regression
coverage exercises a fast exit followed immediately by Node `kill(0)`. A synchronous
probe caches entry but does not emit Node's `spawn` event; asynchronous polling emits
it before `exit`, including for listeners attached later in the probe's turn.

Hosts publish the absolute admitted executable through host-owned
`BUNWASM_EXEC_PATH`, independently of the caller's preview1 argv[0]. The guest
captures that as `process.execPath`; `process.argv0` retains the caller argument.
Worker, fork and self-spawn therefore cannot switch engines or fail merely
because a custom environment removes Bun from PATH. Native, Node and browser
fixtures exercise missing and opposite-engine PATHs. Hosts canonicalize relative and
`..` executable names only after original-component admission succeeds, preserving
missing/non-directory errors before `..`. Relative-launched children change directory
and then self-spawn and create Workers using the same admitted engine. The generic
browser process harness also creates real absolute marker files, enrolls child pipe
identities, uses nonconsuming signal/job observations, and asserts typed startup
failures; the generic ABI harness separately tests consuming waits.
Node children select the
same tool module as root lint/format commands. A failed browser worker cannot
be adopted as a running root after asynchronous executable-marker preparation.

Rust CI runs all workspace library and binary unit-test targets with the default
QuickJS host engine. The transpiler's example is a WASI executable rather than a
host test; the POSIX crate is cfg(wasi). Environment defaults remain workstation
paths but honor CI-provided toolchain and scratch locations.

The external-runtime browser gate uses the broker's own root filesystem fence,
not a redundant callback through the guarded public filesystem after disposal
starts. All inherited-fd3 libc controls still execute as explicit expected
failures, with exact ENOENT/EBADF diagnostics and verified teardown, until the
patched wasi-libc follow-up lands.

The Waffle core budget is 7,680 B gzip, matching its upstream budget; this pin
measures 7,516 B. Tagged process directory/control and startup value primitives
remain included in the startup byte totals. Supervisor, registry, table, worker
service, pipes and interrupt rewriting still cannot load before first use.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Process startup and executable identity](#process-startup-and-executable-identity) | Host feature | Original startup-before-wait observation, admitted executable metadata, lazy-root cancellation and Node child tool routing; no upstream implementation copied. |

[Ledger scope and pinned revisions](scope.md).
