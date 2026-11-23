# Filesystem buffer pinning, writev snapshots, recursive readdir and callbacks

## Classification

| Source | Class | Change |
| --- | --- | --- |
| `crates/bunwasm-runtime/src/js/fs_buffers_readdir.ts` (`runSymlinkCallback`) | Adapted implementation | 3- and 4-argument `fs.symlink` callback overload adapted from Bun's `src/js/node/fs.ts`: validates the callback on 3-argument calls, ignores a non-callable 4th argument by falling through to `promises.symlink`, and invokes callable callbacks with a single `(err)` argument (`undefined` on success). |
| `crates/bunwasm-runtime/src/js/fs_buffers_readdir.ts` (`snapshotWritev`, `writevViews`, `readdirTree`, `attachAsyncStack`) | Original adapter | Intrinsic-getter `writev` view conversion and single-pass array snapshot, recursive `readdir` symlink traversal and sync/async error paths, and non-destructive async stack attachment. |
| `crates/bunwasm-runtime/src/js/node_fs.js` | Original adapter | Thin wiring for pending stdin `read`/`readv` buffer pins, lazy `fs_buffers_readdir` loading, and snapshotting the diagnostic path in `promises.open`. |

Upstream revision: Bun `9510e74152073d850a18758ca41114d8f214ffa6`. Behaviour was compared
against native Bun 1.4.4. No upstream file is patched.

## Local behavior

- **Pending stdin pins**: `fs.read` and `fs.readv` pin destination buffers across
  `runtime_proc` `EAGAIN` waits until the bytes have been written into the views, then
  release the pin before invoking the user callback on both success and error.
- **`writev` views**: `snapshotWritev` reads `buffers.length` once so element getters
  cannot extend the write vector, and `writevViews` reads `buffer`, `byteOffset`,
  `byteLength`, and `ArrayBuffer.prototype.detached` through captured prototype getters so
  shadowed own properties cannot spoof slices and detached `TypedArray`/`DataView` objects
  write zero bytes without throwing.
- **Recursive `readdir`**: descends into symlinked directories, skips `ENOENT`/`ENOTDIR`
  symlink targets, rethrows other errors such as `ELOOP`, normalizes `Dirent.parentPath`,
  and matches Bun's sync (`scandir` on the root path) vs async (`open` on the failing child
  path) error shape.
- **Promise async stacks**: `attachAsyncStack` checks descriptor writability and object
  extensibility before appending captured `\n    at async ` frames, preserving frozen errors
  and any existing stack frames.

The fixtures `tests/fixtures/fs-buffers-readdir-callbacks`,
`tests/fixtures/fs-async-stdin-pins`, and `tests/fixtures/fs-file-handle-gc` cover these
contracts against native Bun 1.4.4 on QuickJS, JavaScriptCore, and the Browser engine.
