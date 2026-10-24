## esbuild WebAssembly distribution

Class **Host feature**. The distribution selector in
`crates/bunwasm-runtime/src/install/resolve.rs` maps `esbuild` to the matching
`esbuild-wasm` version. The original subprocess adapter in
`crates/bunwasm-runtime/src/js/spawn.ts` accepts `node` as a guest runtime name.
The original stdin adapters in `crates/bunwasm-runtime/src/js/node_fs.js`,
`crates/bunwasm-runtime/src/natives.rs`,
`crates/bunwasm-host/src/process/mod.rs`, `process/stdin.rs`, `process/stdio.rs`,
its slot and notification hooks,
and the Waffle process ABI let callback reads wait through the host I/O loop.
The original `node_fs.js` callback adapter selects `procRead` for fd 0 when the
process ABI is available, rather than calling the networking `hostRead` slot.
It registers a descriptor READABLE subscription with the existing `net.js`
waiter scheduler and retains the waiter for WASI EAGAIN (`-6`). Other negative
WASI errnos become Node-style read errors: `-2` is EACCES and `-4` is
EADDRNOTAVAIL, not legacy retry or synchronous-fallback statuses. Completion
preserves the caller's buffer and captured async context. Synchronous reads,
non-stdin callback reads, and promise FileHandle reads keep their existing WASI
native path. The original fixture `scripts/node-fs-runtime-proc.test.ts`
executes these fs and waiter implementations with a controlled native boundary;
it covers partial reads, EOF, empty reads, readiness retries, error mapping,
callback context, and the unchanged synchronous paths. This is a change to our
original host adapter, not copied Bun, Node, or esbuild code.
The original browser filesystem service in `waffle/fs/`, connected by
`web/src/fs-worker.ts` and `web/src/worker.ts`, gives parents and descendants
one live filesystem identity. Changes are visible before stdin, stdout, or exit
boundaries, including parent edits while a persistent child waits without stdin.
The service replaces the earlier snapshot baselines and filesystem mailboxes;
open descriptors retain their original file identity across removal or replacement.
Native hosts use their shared physical filesystem.
The original shared allocator uses sparse two-level page tables so one file can
span all storage segments within the configured cap. Table blocks are returned
on truncation, removal, or failed growth. Growth reserves tables after choosing
physical capacity, so geometric growth can fall back to the remaining free pages.
Metadata remains within the original
24 MiB connection buffer. Allocation range errors use WASI EFBIG, number 22;
number 27 is EINTR and would make Rust retry a rejected write indefinitely.
The original browser test adapter in `web/tests/stop-shell.ts` waits for an idle
shell before submitting the next command. Ctrl-C text can appear before
asynchronous worker cleanup finishes.
The synchronous path reads the WASI descriptor without Rust stdin prefetching.
The native WASI and host interfaces share a buffer, including bytes read ahead.
This prevents Go's service loop from blocking JavaScript callbacks and preserves
stdin position when callers mix synchronous and callback reads.
No upstream implementation is copied or patched. The published esbuild 0.25.12
files `lib/main.js`, `bin/esbuild`, `wasm_exec_node.js`, `wasm_exec.js`, and
`esbuild.wasm` install unchanged from the official npm tarball. Its source is
`evanw/esbuild` tag `v0.25.12`, including `lib/npm/node.ts`,
`lib/npm/node-platform.ts`, `npm/esbuild-wasm/bin/esbuild`, and the Go compiler runtime.
The package owns that Go runtime revision. Our test fixtures and subprocess
changes are original adapters, separate from those upstream files.

The worker-thread adapter now loads and starts separate guests. SharedArrayBuffer
cannot cross those guest boundaries yet, so esbuild's synchronous worker backend
still needs that follow-up. No package-specific environment override is installed.

Filesystem visibility does not depend on timestamp comparisons or host I/O
polling: the shared service owns namespace changes and the allocator, and shared
file locks and epochs protect direct reads and writes. The original `wasiPipe`
adapter only transports bytes; it has no filesystem synchronization hooks.
The applications select hoisted native Bun installs to avoid the recorded build
plugin path-validation bug; no upstream loader or global package state changes.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [esbuild distribution, worker capability, and subprocess adapters](#esbuild-webassembly-distribution) | Host feature | Select the unchanged official wasm distribution, detect unavailable workers, and support asynchronous stdin through process descriptors with live shared filesystem changes and large files. |

[Ledger scope and pinned revisions](scope.md).
