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
with no polling fallback. Its descriptor namespace records the host path of each Wasmtime
descriptor (the preopens, then every `path_open`), so `watch_open(fd)` watches the canonical
node that descriptor names. Each delivered notification bumps the network notification that
`Slot::Poll` waits on, so a native guest wakes on the commit like a browser guest. Records,
coalescing, the 128-record bound, overflow, end of stream and the errnos follow the Waffle ABI.
`notify` reports a new directory before watching it and never reports entries that already
exist inside it. So when a recursive watch drains a directory create, it walks that
directory and reports each entry as a rename, as Node's recursive watcher does. A native
host reports no `ECANCELED`, because it has no revocable filesystem connection.

The pinned Waffle and `bun.wasm` land as a pair, because the WASI adapter rejects unknown
`runtime_fs` names.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`src/js/fs_watch.ts`, `net.js` watch-first pump, `fsWatch*` natives, web notification wiring, native `runtime_fs` host](#portable-filesystem-watcher) | Host feature | Original event-driven watcher over Waffle `runtime_fs` watch ids, with Node listener identity, and an original native host over `notify`. |

[Ledger scope and pinned revisions](scope.md).
