# fs.openAsBlob

Class: Adapted implementation.

`openAsBlob` in `crates/bunwasm-runtime/src/js/node_fs.js` follows Bun's
`src/js/node/fs.ts` `openAsBlob` at revision
`9510e74152073d850a18758ca41114d8f214ffa6`: it returns a promise of
`Bun.file(path, options)`, a Blob that reads the file lazily, so `options.type`
sets its MIME type and a path, URL or descriptor works wherever `Bun.file`
accepts it. It reaches `Bun.file` through the `bun` builtin rather than
`globalThis.Bun`. The one-line body is copied in shape; no other upstream code
is involved.

Before this, `node:fs` had no `openAsBlob` export, so any module importing it,
including Bun's own `test/js/node/fs/fs.test.ts`, failed to link. The
`fs-open-as-blob` fixture compares the export, the promise, the size, the
contents, the `type` option, slicing and a `file:` URL with native Bun 1.4.4.
