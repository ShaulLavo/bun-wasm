# fs.openAsBlob and fs.statfs

Class: Adapted implementation (`openAsBlob`), Host feature (`statfs`).

`openAsBlob` in `crates/bunwasm-runtime/src/js/node_fs.js` follows Bun's
`src/js/node/fs.ts` `openAsBlob` at revision
`9510e74152073d850a18758ca41114d8f214ffa6`: it returns a promise of
`Bun.file(path, options)`, a Blob that reads the file lazily, so `options.type`
sets its MIME type and a path, URL or descriptor works wherever `Bun.file`
accepts it. It reaches `Bun.file` through the `bun` builtin rather than
`globalThis.Bun`. The one-line body is copied in shape; no other upstream code
is involved.

`statfsSync` is an original adapter in
`crates/bunwasm-runtime/src/js/fs_statfs.ts`. WASI has no statfs call, so for an
existing path it throws the system error libuv gives where the call is missing:
`ENOSYS: function not implemented, statfs '<path>'` with errno -38 and syscall
`statfs`. A missing path throws the `stat` ENOENT error relabeled with syscall
`statfs`, as Node and Bun report it. The callback `statfs` and
`fs.promises.statfs` derive from it the same way as the other synchronous
functions. Native Bun returns real filesystem numbers for an existing path; a
host statfs call would be needed to match that.

Before this, `node:fs` exported neither, so any module importing them,
including Bun's own `test/js/node/fs/fs.test.ts`, failed to link. The
`fs-open-as-blob` fixture compares the export, the promise, the size, the
contents, the `type` option, slicing and a `file:` URL with native Bun 1.4.4.
The `fs-statfs-missing` fixture compares the three forms' exports and their
ENOENT errors.
