## Portable filesystem watcher

Class **Host feature**, **original adapter** in `src/js/fs_watch.ts`, wired by
`src/js/node_fs.js`. No upstream implementation is copied. Bun's
`src/js/internal/fs/watch.ts` at `cd95fa7a13b3f13be73e512b38ec111c1c228084`
wraps a private native filesystem watcher that these engines cannot call.

The adapter snapshots file identity, size and modification time through the
existing Rust filesystem operations. A referenced 100 ms timer polls for change
and rename events. Recursive traversal does not follow directory symlinks.
`close`, `ref`, `unref`, persistent options and abort signals control the actual
timer. Closing a watcher releases its timer and signal listener. Polling can
coalesce changes between samples and does not promise an OS event count.
Both `watch(path, callback)` and `watch(path, options, callback)` register the
original callback directly, matching Node v22.14.0 `lib/fs.js` `watch()` and
`lib/internal/fs/watchers.js` EventEmitter dispatch. No Node source is copied.
The fixture checks raw listener identity, single registration, `once`, `off`,
removal by the original callback, and callback receiver on both overloads.
`watchFile` and the promise-based watcher remain unsupported. `watchFile` has a
separate stat-sampling contract; a future event-driven `watch` backend must not
change that contract.

The original adapter validates filename encodings before reading the filesystem
or allocating its timer. Both string and object options reject unknown encodings
with `ERR_INVALID_ARG_VALUE`. Null and empty object encodings select UTF-8, as in
Bun 1.4.4 and Node 26.12.1. The `fs-watch-options` compiled-guest fixture covers
registration errors and supported defaults. The source-factory controls also
check that invalid encodings allocate no timer and perform no filesystem reads.
These are public-option checks, not acceptance of event-driven notifications.

Replacing snapshot polling remains tracked by bun-wasm #176 and depends on
Waffle #106. The current backend still polls. It does not yet provide Waffle
subscription readiness, cross-writer notification or overflow handling.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`src/js/fs_watch.ts` and `node_fs.js` wiring](#portable-filesystem-watcher) | Host feature | Original polling watcher over the shared WASI file operations, with Node listener identity. |

[Ledger scope and pinned revisions](scope.md).
