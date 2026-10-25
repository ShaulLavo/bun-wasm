### Node Buffer fragments

`crates/bunwasm-runtime/src/js/buffer.js`. Class **Port**. Comparison sources are Node `lib/buffer.js` at the Node comparison revision, plus Bun `src/js/builtins/JSBufferConstructor.ts` and `src/node-fallbacks/buffer.js` at the Bun pin. The direct Node import revision is not recorded.

Retain recognizable Buffer constructor dispatch, `fromObject` array-like handling, and concatenation fragments. Adapt the FastBuffer pattern to locally allocated `Uint8Array` storage without Node's native binding, unsafe allocator, or pool. Local codecs, `DataView` numeric access, validation helpers, and factory wiring provide the remaining implementation. `copyBytesFrom` validates the view first and returns an empty Buffer for an empty view before checking either range argument. For nonempty views it validates the offset, returns empty at or past the end, then validates the length before slicing. This ordering is an original adapter correction checked against native Bun 1.4.4 and Node 26.12.1, not a newly copied upstream implementation. Negative and fractional ranges still throw when their validation is reached. This is a mixed file with adapted routines, not an unmodified copy of Node's entire Buffer module.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/buffer.js`](#node-buffer-fragments) | Port | Adapt Node Buffer construction and concatenation routines over typed arrays; preserve native empty-copy range validation order. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
