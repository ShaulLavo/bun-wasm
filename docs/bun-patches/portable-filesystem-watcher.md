## Portable filesystem watcher

Class **Host feature**, **original adapter** in `src/js/fs_watch.ts`, wired by
`src/js/node_fs.js`. No upstream implementation is copied. Bun's
`src/js/internal/fs/watch.ts` at `cd95fa7a13b3f13be73e512b38ec111c1c228084`
wraps a private native filesystem watcher that these engines cannot call.

Each watcher owns one runtime filesystem watch descriptor, opened by the
`fsWatchOpen(path, recursive)` native after the existing `statSync` check. There is
no timer and no tree scan. The watcher registers one I/O waiter with a 16-byte
READABLE subscription on that descriptor, so the event loop sleeps on it like any
other runtime_proc descriptor. Each step reads packed records with `procRead`
until `-EAGAIN`. A record is `u8` type (1 change, 2 rename, 3 overflow), three zero
bytes, a little-endian `u32` name length (`0xffffffff` for the watched root) and the
UTF-8 relative name. Root events report the watched path's basename, as before.

`persistent`, `ref` and `unref` set the waiter's reference. `close`, an abort
signal, end of stream (`0`), a read error and overflow all release the
descriptor with `procClose` and remove the waiter. Read errors and overflow emit
`error` (`syscall: "watch"`, overflow as `EOVERFLOW`) before the later `close`. A
throwing `change` listener becomes an `error` event and releases the watch.
Events can coalesce, and the adapter promises no OS event count.

`net.js` `pumpIo` steps waiters marked `late` (filesystem watches) after the
others. If the host makes a committed write readable by the next descriptor read,
then that write reaches `change` listeners in the same pump as any socket bytes
read in that pump, before their promise continuations. The adapter claims no
other ordering. This closes the Next same-route reload race traced in wave
2026-10-29, where a 100 ms snapshot poll learned of an edit after the reload had
already been answered.

Both `watch(path, callback)` and `watch(path, options, callback)` register the
original callback directly, matching Node v22.14.0 `lib/fs.js` `watch()` and
`lib/internal/fs/watchers.js` EventEmitter dispatch. No Node source is copied.
The fixture checks raw listener identity, single registration, `once`, `off`,
removal by the original callback, and callback receiver on both overloads.
The [promise-based watcher](fs-promises-watch.md) wraps this callback watcher.
`watchFile` remains unsupported and has a separate stat-sampling contract.

The adapter validates filename encodings before reading the filesystem or opening
a descriptor. Both string and object options reject unknown encodings with
`ERR_INVALID_ARG_VALUE`. Null and empty object encodings select UTF-8, as in
Bun 1.4.4 and Node 26.12.1. The `fs-watch-options` compiled-guest fixture covers
registration errors and supported defaults. `scripts/runtime-fs-watch-options.test.ts`
checks that invalid encodings stat nothing and open no descriptor, and
`scripts/runtime-fs-watch-events.test.ts` covers delivery, ordering and lifecycle
over the real `net.js` scheduler.

The descriptor import, its readiness in both the process poll and the network
host poll, and the record format are a Waffle runtime contract requested for
bun-wasm #176 (Waffle #106 shipped the service side in #134). The `fsWatchOpen`
native and the native wasmtime host's implementation land with that contract.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`src/js/fs_watch.ts`, `net.js` late waiters and `node_fs.js` wiring](#portable-filesystem-watcher) | Host feature | Original event-driven watcher over a runtime watch descriptor, with Node listener identity. |

[Ledger scope and pinned revisions](scope.md).
