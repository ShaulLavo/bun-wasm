# App-matrix guest workspace

Class **Host feature**, **original adapter** in
`scripts/app-matrix/guest-command.ts`, called by `run.mjs`. No upstream code is
copied. The helper assembles the existing host command and guest environment.
The caller still selects the host and Wasm artifacts.

Guest projects mount at `/app`, with cwd and home there. Temp and package cache
paths stay inside that mount. Vite 7.1.12's bundled chokidar 3.6.0 records an
empty-name child when watching `/` under its own parent. A directory scan then
removes that child recursively and reports unchanged config files as deleted.
A native host A/B with the same readable fixture reproduces that removal at
`/` and stays quiet at `/app`. This is a workspace setup choice, not an engine
or watch-event workaround. The separate
[WASI metadata adapter](filesystem-options.md) supplies readable presentation
modes because Preview1 has no POSIX permission bits. Both conditions are needed
for a quiet config watch in the retained diagnostic pair.

Reference: Vite npm tarball `vite-7.1.12.tgz`, SHA256
`85f5144ff94a0ee96ae48b142fb4f26a704381723702c6acd467020d43c657bf`,
`dist/node/chunks/config.js`'s bundled chokidar
`lib/nodefs-handler.js` and `index.js`. The bounded investigation evaluates
those existing functions without modifying them. Repository tests cover the
guest mount and writable paths, host/artifact selection, arguments, and network
environment. New guest app acceptance remains a separate producer-owned check.

| Source | Class | Change |
| --- | --- | --- |
| `scripts/app-matrix/guest-command.ts` and `run.mjs` wiring | Host feature, original adapter | Put the guest workspace below the filesystem root. |
