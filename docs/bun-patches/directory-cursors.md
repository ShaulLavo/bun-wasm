## Directory cursors

Class **Host feature**. `crates/bunwasm-runtime/src/directory.rs` and the directory
APIs in `src/js/node_fs.js` and `web/src/engine-host.js` are original adapters. They implement Node's public
`opendir`, `opendirSync`, `fs.promises.opendir` and `Dir` contract without copying
an upstream implementation. Bun's `src/js/node/fs.ts` at pinned upstream revision
`9510e74152073d850a18758ca41114d8f214ffa6` was read as a reference. Its `Dir` eagerly
collects directory entries through native `fs.readdir`, so it cannot supply bounded
reads over this runtime's WASI directory handles.

Rust owns open `std::fs::ReadDir` cursors and recursive traversal. Each native read
returns at most `bufferSize` entries. Raw filename bytes cross the engine boundary
before JavaScript applies the requested encoding. JavaScript owns the async operation
queue, callback timing, Dirent construction, iteration and explicit disposal.
Closing drops the active native cursor and pending traversal paths. `FinalizationRegistry`
releases abandoned native IDs through an idempotent native release. Its unregister
token is separate from the owner, because the pinned QuickJS stores tokens strongly.
Runtime shutdown clears the remaining cursor table after user exit listeners, including when the host
retains the wasm instance. The browser engine also clears it in `EngineHost.exit`
before notifying the host. This covers `reallyExit`, abort, self-kill and fatal
errors that bypass exit listeners. The release is idempotent across both paths.
Native exits also clear the table before skipping engine teardown.
The public path representation stays separate from the lookup string, so Buffer paths remain Buffers in `Dir.path` and
`Dirent.parentPath`. The async queue keeps a refill operation active through its callback,
while an already-buffered read does not block synchronous work. The fixture is original
test code and runs against Node as a contract control.

Recursive traversal is breadth-first. Node's order can change with buffer size;
this adapter does not promise that order. Directory enumeration order is unspecified.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/directory.rs`, `src/js/node_fs.js`, `web/src/engine-host.js`, directory cursors](#directory-cursors) | Host feature | Original directory handles, bounded reads, recursive traversal and Node Dir adapters. |
