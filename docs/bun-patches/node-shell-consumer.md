# Node fixture shell consumer

Class **Original adapter**. `web/scripts/node-shell.ts`, `node-host.ts`,
`node-spawn.ts` and `node-process.ts` connect the existing Node worker host to
the pinned Bash and env guests. No upstream implementation is copied.

The consumer pins bash-web at `e6d29598eb0111f16bc3068ad52a9167dac51da7`
and Waffle at `b6ce9c22e4032637814a3985fab934915be02bcc`, released as
0.0.130. The existing `scripts/bash-web-guests.ts` receipt verifier checks the
Bash pin and both guest hashes before loading either program. The Node host
accepts the native launcher's `--shell` and `--env-utility` arguments as one
complete receipt-backed pair. Partial, modified or stale inputs fail startup.

The strict executable registry admits `/bin/sh`, `/bin/bash`, `/bin/env` and
`/usr/bin/env` only through their configured modules and live private files.
The host mounts and removes those files alongside its existing Bun executables.
Shell and env use the ordinary preview1 worker path, process supervisor, job,
preopens, descriptor bindings, pipe relays and cancellation handling. They do
not pass through Bun's lint/format command selection. No operating-system
shell, Node exec, dependency change or engine change is involved.

The registry reads a bounded shebang prefix through guest path resolution and
admits its interpreter through the same strict registrations. It does not load
arbitrary Wasm files or select a host executable. Invalid unregistered files
still fail executable-access queries with EACCES; after inspecting their bytes,
spawn now reports ENOEXEC. Tests retain both errors explicitly.
Executable sources must be regular files. Nonblocking open and a descriptor-type
recheck also reject a path replaced with a FIFO without blocking the broker.
`runtime_proc.inherited_fd` enumerates a snapshot of launch descriptors taken
after bindings and default root stdio, before preopens. Closing a descriptor
does not rewrite that snapshot. This follows the original Waffle
`browser/worker.ts` contract at the revision above, without copying its code.

The noninteractive imports mirror `crates/bunwasm-host/src/slots.rs`'s existing
shell contract: inherited descriptors 0 through 2, 80 by 24 geometry, no phase
owner or prompt provider, and permission queries returning WASI NOTSUP because
Node's native filesystem has no Waffle inode metadata. These imports share the
process cancellation guard and never read memory for an unsupported query.
The private package handoff remains cancellation-first NOTSUP.

`scripts/test.sh` builds the existing pinned pair for Browser runs and passes it
explicitly, including under `--no-build`. The package behavior fixture retains
its assertions and its single native owner selecting all three maintained
engines. Focused tests cover strict admission, byte/pin rejection, linking,
cancellation and removal of private files.
