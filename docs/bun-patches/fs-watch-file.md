# Stat-polling file watcher

Class **Host feature**, **original adapter** in
`crates/bunwasm-runtime/src/js/fs_watch.ts`, beside the
[notification watcher](portable-filesystem-watcher.md) as in Node's
`internal/fs/watchers`, and wired by `node_fs.js` as `fs.watchFile` and
`fs.unwatchFile`. No upstream implementation is copied. The
API reference is Node's documented `fs.watchFile`, `fs.unwatchFile` and
`fs.StatWatcher`, with libuv's `uv_fs_poll` change rule. The fixture's expected
output is native Bun 1.4.4, and Node 26.12.1 prints the same events.

`fs.watchFile` is Node's stat-polling watcher. It needs no filesystem
notifications: a timer stats the path every `interval` milliseconds (default
5007) and emits `change(current, previous)` when the device, inode, mode, owner,
size, or modification, change or birth time differs, or when the file appears or
disappears. A missing file reads as all-zero `Stats` (or `BigIntStats` with
`bigint: true`). A file missing at start reports one change with both stats zero,
as libuv's first failed stat does in Bun and Node. All listeners of one resolved
path share one watcher, which `watchFile` returns. `unwatchFile(path, listener)`
removes one listener and `unwatchFile(path)` removes all; the watcher stops and
emits `stop` when none remain. `persistent: false` unrefs the timer, and the
watcher's `ref()`/`unref()` reach it too.

TypeScript's `tsserver` watches missing files (absent `tsconfig.json` ancestors,
`node_modules/@types`, unresolved modules) with `fs.watchFile`. Before this adapter
the call threw, so `tsserver` failed every `updateOpen` request and the
TypeScript language server published no diagnostics.

Run the focused checks with:

```sh
source env.sh
scripts/test.sh --engine quickjs fs-watch-file
scripts/test.sh --engine jsc fs-watch-file
scripts/test.sh --engine browser fs-watch-file
```

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `StatWatcher`, `watchFile` and `unwatchFile` in `fs_watch.ts`, `node_fs.js` wiring | Host feature | Original stat-polling adapter over the existing `statSync` and `makeStats`. |
| `fs.realpath.native` in `node_fs.js` | Host feature | Aliases the callback `realpath`, as Bun does, so `fs-extra` stops warning. |
| `fs-watch-file` fixture | Host feature | Original control compared against native Bun 1.4.4. |
