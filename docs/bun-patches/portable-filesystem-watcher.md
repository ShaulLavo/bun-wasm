## Portable filesystem watcher

Class **Host feature**, **original adapter** in `src/js/fs_watch.ts`, wired by
`src/js/node_fs.js`. No upstream implementation is copied. Bun's
`src/js/internal/fs/watch.ts` at `cd95fa7a13b3f13be73e512b38ec111c1c228084`
wraps a private native filesystem watcher that these engines cannot call.

Each watcher subscribes through a single process-local watch hub over Waffle's `runtime_fs`
imports (`watch_open`, `watch_ready`, `watch_read`, `watch_next`, `watch_close`; Waffle `docs/host-abi.md`,
"Guest filesystem watches"). `fsWatchResolve(path)` opens the path once (following a final
symlink) and derives its full-width 64-bit `(dev, ino)` identity from that open descriptor.
Watchers on the exact same live `(dev, ino, recursive, path)` share one underlying watch
registration via `fsWatchOpenFd(fd, recursive)` (with `fsWatchDropFd(fd)` releasing the
descriptor in a `finally` entered immediately after reading `resolved[0]` by index; see
`docs/host-abi.md`, "Filesystem watch descriptor natives") while keeping independent
`ResourceFrame`, encoding, `ref`/`unref`, abort signal, registration cursor and listener state;
before a late subscriber joins a shared watch, any events already queued on that watch are
captured into a bounded sequence-gated backlog (capped by records and bytes, opening an
independent registration instead of draining further when saturated so provider overflow is
preserved) so the late subscriber only receives events after it registered. Closing the last
subscriber releases the native id. There is no timer and no tree scan. The hub registers one
`watch: true` I/O waiter with no `runtime_proc` subscriptions, so the idle loop sleeps in the
network host poll and `ioPending()` does not scan every open watcher. The Bun web executor arms
Waffle's notification set for that poll (`NetHost.attachNotifications`), which wakes it when a
filesystem commit is pending for a guest watch. The hub first delivers any captured join
backlogs, then calls `fsWatchNext()` (`runtime_fs.watch_next`, one reused 64 KiB buffer) until
`EAGAIN`. Each call returns the next ready registration's id with its records, its end or a
watch-scoped errno, so the hub never reads an idle watch: Waffle 0.0.155 drains only ready
subscriptions in batched service replies (Waffle PR 653), where one read per watch used to cost
a service round trip each. A watch's own backlog is delivered before anything newer for it. An
error without a watch id fails every watch, and an id the hub doesn't hold is closed. One pump
stops after 4,096 results so a listener that keeps writing inside a watched tree can't starve
other I/O; the provider stays ready and the next turn continues. `fsWatchRead` remains only for
the capped capture when a subscriber joins a shared watch. Delivery and retirement continue for
remaining subscribers if one throws, and unhandled errors reach the uncaught path. A record is `u8`
type (1 change, 2 rename, 3 overflow), three zero bytes, a little-endian `u32` name length
(`0xffffffff` for the watched root and overflow), then the UTF-8 relative name padded to 4 bytes.
Root events report the watched path's basename, as before.

`persistent`, `ref` and `unref` set the waiter's reference. `close`, an abort
signal, end of stream (`0`), a read error, revocation (`ECANCELED`) and overflow all
release the id with `fsWatchClose` and remove the waiter. Read errors and overflow
emit `error` (`syscall: "watch"`, overflow as `EOVERFLOW`) before the later `close`.
A registration refused for the runtime's watch bounds (`EAGAIN`) reports `ENOSPC`, as
Node does for an exhausted inotify limit. A throwing `change` listener becomes an
`error` event and releases the watch. Events can coalesce, and the adapter promises
no OS event count.

`net.js` keeps watch waiters and non-watch waiters in separate sets and delegates each turn to
the original TypeScript adapter `io_pump.ts`, avoiding per-turn array copies and sorting.
It queries the non-consuming `fsWatchReady()` once when watch waiters exist (calling Waffle's
`GuestWatchTable.ready()` directly on the Browser engine, or `runtime_fs.watch_ready()` on Wasm
engines). Zero means no watch read can make progress; nonzero means records, an end or an error
may be available. Idle turns skip every watch read, avoiding host allocation traffic proportional
to the watch count. On the Browser engine, `EngineHost.pump()` skips a second `pumpIo()` call in
the same turn when `loop_scheduler.ts` already pumped I/O before continuing with `next === 0`.
The readiness decision belongs to that turn, including during a reentrant pump. A write racing
a negative query wakes the normal notification path and is delivered next turn.
There is no timer, forced collection or old-host fallback.

The provider's `ready()` includes ended registrations until close/drop as well as
queued records, read errors and revocation. Its scheduling-only `pending()` stays
false for ended/revoked registrations. Consumer controls use the actual provider
table to verify that a terminal read closes the native id and removes its waiter
within the same turn, including when scheduling readiness is false.

`io_pump.ts` steps ready watch waiters before the others. A socket step can run a
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
`bun-wasm/notification-worker` and pass it to `installBunAdapters`. A page-started root
(`web/src/runner.ts` `startRun`) posts its own request, so it creates the same page-owned
relay with Waffle's `createNotificationBridge` when the run is networked. It transfers the
relay's port, and stops the relay after the root worker's physical stop, as Waffle's process
broker does for children. Both use the `notification-worker.js` sibling of the Bun worker, so
the browser build mirrors that sibling into the scoped `__bunwasm/` directory beside
`fs-worker.js` and `preview1-worker.js`. A networked Bun process without a notification scope
fails its launch; there is no polling fallback.

Both `watch(path, callback)` and `watch(path, options, callback)` register the
original callback directly, matching Node v22.14.0 `lib/fs.js` `watch()` and
`lib/internal/fs/watchers.js` EventEmitter dispatch. No Node source is copied.
The fixture checks raw listener identity, single registration, `once`, `off`,
removal by the original callback, and callback receiver on both overloads.
The [promise-based watcher](fs-promises-watch.md) wraps this callback watcher.
`watchFile` is the separate [stat-polling watcher](fs-watch-file.md).

The adapter validates filename encodings before reading the filesystem or opening
a watch. Both string and object options reject unknown encodings with
`ERR_INVALID_ARG_VALUE`. Null and empty object encodings select UTF-8, as in
Bun 1.4.4 and Node 26.12.1. The `fs-watch-options` compiled-guest fixture covers
registration errors and supported defaults. `scripts/runtime-fs-watch-options.test.ts`
checks that invalid encodings stat nothing and open no watch, and
`scripts/runtime-fs-watch-events.test.ts` covers delivery, ordering and lifecycle
over the real `net.js` scheduler.

The native wasmtime host (`crates/bunwasm-host/src/fs_watch.rs`) implements the same five
`runtime_fs` watch imports over the `notify` crate 8.2.0: inotify on Linux and FSEvents on macOS,
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
Its `watch_read` and `watch_next` validate their output spans as Waffle 0.0.155 does (EFAULT, then
EINVAL for overlap). `watch_next` (original) clears the id word and reads the open watches in id
order starting after the one it last reported, so a busy watch can't starve the others; it returns
`EAGAIN` when none has records, an end or a short first record.
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
filesystem, with no Waffle filesystem service and no change source. It answers the five
`runtime_fs` watch imports as Waffle's `Wasi` does for a filesystem without `watches`. `watch_open`
checks the output range (EFAULT), the flags (EINVAL), the guest descriptor in the host's own
descriptor table (EBADF) and its kind (EINVAL for pipes and terminals). A valid file or
directory then reports ENOTSUP and writes no id. No id ever exists, so `watch_read` reports
EFAULT for an out-of-range buffer, EINVAL for overlapping buffer/length spans, and otherwise EBADF,
and `watch_close` reports EBADF.
`fs.watch` on this host throws `ENOTSUP`; there is no polling fallback. Local change: it
validates against the Node host's `DescriptorTable` instead of `Wasi.descriptors`, because
Waffle's `Wasi` methods are private and bound to its own table.
The original `watch_ready` extension returns zero because this host cannot register a watch.
The original `watch_next` extension checks its three spans (EFAULT, then EINVAL for overlap, as
Waffle 0.0.155 does), writes id 0 and reports EAGAIN, because no watch is ever ready.

Releasing the host after a start failure is original. Before `wasi.start()` binds memory,
Node WASI rejects every call with `ERR_WASI_NOT_STARTED`. Only preopens exist then, and the
unstarted instance's own table releases them, so the release ignores that one error code.
`web/tests/node-runtime-fs.test.ts` instantiates guests importing the watch names on a real
Node WASI host and checks each errno and the unstarted release.


## Watcher callback frame

A watcher captures the async-context frame current at `fs.watch()` once the native watch opened
([resource frames](0008-await-context-hooks.md)). Its change and error events, and the close event an error
causes, run in that frame although the host pumps at root. A listener that closes the watcher and then
throws gets its `error` event in the same frame. A caller's `close()` and an abort keep their own frame, as
before. Closing releases the frame in a `finally`, also on constructor rollback, so a closed watcher kept
reachable holds nothing once its queued close event ran. Native Bun and Node report the watch frame for
change events; error and close parity was not measured natively.

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
