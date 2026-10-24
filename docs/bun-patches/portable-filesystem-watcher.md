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
`watchFile` and the promise-based watcher remain unsupported.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`src/js/fs_watch.ts` and `node_fs.js` wiring](#portable-filesystem-watcher) | Host feature | Original polling watcher over the shared WASI file operations, with Node listener identity. |
