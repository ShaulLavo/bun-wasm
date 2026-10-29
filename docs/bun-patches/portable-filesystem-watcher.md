## Portable filesystem watcher

Class **Host feature**, **original adapter** in `src/js/fs_watch.ts`, wired by
`src/js/node_fs.js`. No upstream implementation is copied. Bun's
`src/js/internal/fs/watch.ts` at `cd95fa7a13b3f13be73e512b38ec111c1c228084`
wraps a private native filesystem watcher that these engines cannot call.

Each watcher owns one process-local watch id from Waffle's `runtime_fs` imports
(`watch_open`, `watch_read`, `watch_close`; Waffle `docs/host-abi.md`, "Guest
filesystem watches", frozen in wave 2026-10-29 `waffle/guest-watch/DESIGN.md`
revision 2). The `fsWatchOpen(path, recursive)` native opens the path with symlink
follow after the existing `statSync` check, registers the watch on that descriptor
and closes it; the watch follows the node's identity. There is no timer and no tree
scan. The watcher registers one I/O waiter with no runtime_proc subscriptions, so the
idle loop sleeps in the network host poll. The Bun web executor arms Waffle's
notification set for that poll (`NetHost.attachNotifications`), which wakes it when a
filesystem commit is pending for a guest watch. Each step drains `fsWatchRead`
(one reused 64 KiB buffer) until `EAGAIN`. A record is `u8` type (1 change,
2 rename, 3 overflow), three zero bytes, a little-endian `u32` name length
(`0xffffffff` for the watched root and overflow), then the UTF-8 relative name
padded to 4 bytes. Root events report the watched path's basename, as before.

`persistent`, `ref` and `unref` set the waiter's reference. `close`, an abort
signal, end of stream (`0`), a read error, revocation (`ECANCELED`) and overflow all
release the id with `fsWatchClose` and remove the waiter. Read errors and overflow
emit `error` (`syscall: "watch"`, overflow as `EOVERFLOW`) before the later `close`.
A registration refused for the runtime's watch bounds (`EAGAIN`) reports `ENOSPC`, as
Node does for an exhausted inotify limit. A throwing `change` listener becomes an
`error` event and releases the watch. Events can coalesce, and the adapter promises
no OS event count.

`net.js` `pumpIo` steps watch waiters before the others. A socket step can run a
request handler synchronously, so a change already readable this turn reaches its
listeners, and queues their deferred work, ahead of it. That is a tie-breaker only.
The actual fix is waking on commit: the guest drains the watch as soon as a write
commits, normally before a reload's bytes arrive. The adapter relies on Waffle's
property 6 (a drain that begins after a successful write returned reports it or an
overflow) and claims no other ordering. Watcher libraries that defer their own
handling are not covered. The unordered Next reload trace from wave 2026-10-29 is the
acceptance evidence.

Every Bun launcher passes a `notificationWorkerUrl` (Waffle's
`browser/notification-worker` bundle). The playground bundles
`web/src/notification-worker.ts` beside its Bun worker. Package callers bundle
`bun-wasm/notification-worker` and pass it to `installBunAdapters`. A networked Bun
process without a notification scope fails its launch; there is no polling fallback.

Both `watch(path, callback)` and `watch(path, options, callback)` register the
original callback directly, matching Node v22.14.0 `lib/fs.js` `watch()` and
`lib/internal/fs/watchers.js` EventEmitter dispatch. No Node source is copied.
The fixture checks raw listener identity, single registration, `once`, `off`,
removal by the original callback, and callback receiver on both overloads.
The [promise-based watcher](fs-promises-watch.md) wraps this callback watcher.
`watchFile` remains unsupported and has a separate stat-sampling contract.

The adapter validates filename encodings before reading the filesystem or opening
a watch. Both string and object options reject unknown encodings with
`ERR_INVALID_ARG_VALUE`. Null and empty object encodings select UTF-8, as in
Bun 1.4.4 and Node 26.12.1. The `fs-watch-options` compiled-guest fixture covers
registration errors and supported defaults. `scripts/runtime-fs-watch-options.test.ts`
checks that invalid encodings stat nothing and open no watch, and
`scripts/runtime-fs-watch-events.test.ts` covers delivery, ordering and lifecycle
over the real `net.js` scheduler.

The native wasmtime host (`crates/bunwasm-host/src/fs_watch.rs`) implements the same three
`runtime_fs` imports over the `notify` crate 8.2.0: inotify on Linux and FSEvents on macOS,
with no polling fallback. A watch follows the node the descriptor holds, never a saved
pathname, so a rename, a replacement at the old path or `fd_renumber` cannot redirect it.
`watch_open(fd)` reads that descriptor's preview1 `filestat` through Wasmtime's own
`fd_filestat_get` into private scratch memory. Its `ino` is wasmtime-wasi's identity hash of
the host device and inode ([adapted below](#wasmtime-preview1-node-identity)). The host then
duplicates every candidate descriptor of the process and keeps the one whose `fstat`
identity matches. The match never goes through a name, and a reused descriptor number cannot
substitute another file. An unlinked node (`st_nlink == 0`) reports ENOENT, as Waffle does
for a detached node.

On Linux, the backend registers that duplicate's `/proc/self/fd/<fd>` link. The kernel
resolves it to the descriptor's inode, so no rename or swap of names, even one between
resolving and registering, can make the watch hold a different node. The watch owns the
duplicate, so the paths `notify` derives later (subdirectories added to a recursive watch)
resolve through the same descriptor even after the guest closes its own. A test reads the
kernel's registered inodes from `/proc/self/fdinfo`. It forces a name swap between the two
steps of the old resolve-then-register binding, where the kernel registers the other file
while a path check still passes, and shows the descriptor link registers the held inode
under the same swap.

macOS FSEvents subscribes by path for the watch's whole life, so there the host registers the
duplicate's current `F_GETPATH` and checks the identity once. That binding is path-scoped,
not descriptor-scoped, and is not covered by the Linux kernel proof. The macOS boundary is
unqualified: no macOS run has exercised it. A WASI-level test also
pins Wasmtime's `ino` to the host identity, so a Wasmtime change to it fails the tests. Each delivered
notification bumps the network notification that `Slot::Poll` waits on, so a native guest wakes on the commit like a browser guest. Records,
coalescing, the 128-record bound, overflow, end of stream and the errnos follow the Waffle ABI.
`notify` reports a new directory before watching it and never reports entries that already
exist inside it. So when a recursive watch drains a directory create, it walks that
directory and reports each entry as a rename, as Node's recursive watcher does. A native
host reports no `ECANCELED`, because it has no revocable filesystem connection.

The pinned Waffle and `bun.wasm` land as a pair, because the WASI adapter rejects unknown
`runtime_fs` names.

## Node fixture host watch answer

Class **Host feature**, **adapted implementation** in `web/scripts/node-process.ts`
`watchImports`. Upstream: Waffle 0.0.103 (git `dc945b0ea353959c1d3d7589dd43afb57ceeb14d`),
`core/wasi.ts` `Wasi.watchOpen` (lines 511-525), `Wasi.watchRead` (527-533) and the
`watch_close` import (396).

The Node host (`web/scripts/node-host.ts`, used by `scripts/jsc-embedding.ts` and
`scripts/test.sh --engine browser`) runs guests on Node's `node:wasi` over the real
filesystem, with no Waffle filesystem service and no change source. It answers the three
`runtime_fs` imports as Waffle's `Wasi` does for a filesystem without `watches`. `watch_open`
checks the output range (EFAULT), the flags (EINVAL), the guest descriptor in the host's own
descriptor table (EBADF) and its kind (EINVAL for pipes and terminals). A valid file or
directory then reports ENOTSUP and writes no id. No id ever exists, so `watch_read` reports
EFAULT for an out-of-range buffer and otherwise EBADF, and `watch_close` reports EBADF.
`fs.watch` on this host throws `ENOTSUP`; there is no polling fallback. Local change: it
validates against the Node host's `DescriptorTable` instead of `Wasi.descriptors`, because
Waffle's `Wasi` methods are private and bound to its own table.

Releasing the host after a start failure is original. Before `wasi.start()` binds memory,
Node WASI rejects every call with `ERR_WASI_NOT_STARTED`. Only preopens exist then, and the
unstarted instance's own table releases them, so the release ignores that one error code.
`web/tests/node-runtime-fs.test.ts` instantiates a guest importing the three names on a real
Node WASI host and checks each errno and the unstarted release.


## Wasmtime preview1 node identity

Class **Host feature**, **adapted implementation** in `crates/bunwasm-host/src/fs_watch.rs`
`node_identity`. Upstream: wasmtime-wasi 39.0.2 (crates.io; git `f66a5b61465c937aba66d73cd5d82f763cc3074f`,
`crates/wasi`), `src/filesystem.rs` `impl From<&cap_std::fs::Metadata> for MetadataHashValue`
(lines 327-351; `lower` at 335-338), which `p1.rs` `fd_filestat_get` reports as `ino: metadata_hash.lower`.

The adaptation hashes the host `st_dev` then `st_ino` with `std::collections::hash_map::DefaultHasher::new()`
and returns `finish()`, which is the same computation as upstream's `lower` half. It omits the
synthesized `upper` half. It takes `std::fs::Metadata` instead of `cap_std::fs::Metadata`.
Reason: the native host must recognize which host descriptor holds the node a guest
descriptor names, and preview1 exposes only this hash. The equality holds only because both
sides are compiled into one binary with the same `DefaultHasher`. Upstream notes the value may
change across rustc releases. The WASI test
`runtime_fs_watches_the_descriptor_node_through_rename_replacement_and_renumber` asserts
`fd_filestat_get(fd).ino == node_identity(host metadata)`, so any upstream change fails the
tests. Revisit this when the Wasmtime pin moves.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`src/js/fs_watch.ts`, `net.js` watch-first pump, `fsWatch*` natives, web notification wiring, native `runtime_fs` host](#portable-filesystem-watcher) | Host feature | Original event-driven watcher over Waffle `runtime_fs` watch ids, with Node listener identity, and an original native host over `notify` that watches the descriptor's node. |
| [`web/scripts/node-process.ts` `watchImports`](#node-fixture-host-watch-answer) | Host feature | Adapted from Waffle 0.0.103 `Wasi.watchOpen`/`watchRead` for a filesystem without watches: the Node host's descriptors validate, then ENOTSUP; original release of an unstarted Node WASI host. |
| [`crates/bunwasm-host/src/fs_watch.rs` `node_identity`](#wasmtime-preview1-node-identity) | Host feature | Adapted from wasmtime-wasi 39.0.2 `MetadataHashValue::from` (the `lower` half), to match a guest descriptor's preview1 `ino` to a host descriptor. |

[Ledger scope and pinned revisions](scope.md).
