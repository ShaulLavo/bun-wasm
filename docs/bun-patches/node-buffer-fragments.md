### Node Buffer fragments

`crates/bunwasm-runtime/src/js/buffer.js`. Class **Port**. Comparison sources are Node `lib/buffer.js` at the Node comparison revision, plus Bun `src/js/builtins/JSBufferConstructor.ts` and `src/node-fallbacks/buffer.js` at the Bun pin. The direct Node import revision is not recorded.

Retain recognizable Buffer constructor dispatch, `fromObject` array-like handling, and concatenation fragments. Adapt the FastBuffer pattern to locally allocated `Uint8Array` storage without Node's native binding, unsafe allocator, or pool. Local codecs, `DataView` numeric access, validation helpers, and factory wiring provide the remaining implementation. This is a mixed file with adapted routines, not an unmodified copy of Node's entire Buffer module.


`buffer_fill_args.ts` is an original adapter, not copied upstream code. It selects
Buffer.fill's encoding overload before the existing Buffer adapter validates the
numeric range. A string third argument after a numeric start is the encoding,
not the end offset. That selected encoding is validated before an empty-range
return, without encoding the fill value. An undefined start takes the default
UTF-8 whole-buffer path and ignores later arguments. Non-string fill values
retain numeric end validation. The
small TypeScript factory is discovered by the existing polyfill build; the
legacy JavaScript factory delegates only argument selection to it.

Bun 1.4.4 and Node 26.12.1 agree on the five-byte latin1/hex controls in
`tests/fixtures/buffer-fill-encoding`. `scripts/buffer-fill.test.ts` exercises
the production Buffer factory with the helper emitted by the production
TypeScript stripping script. No upstream source was copied for this fix.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/buffer.js`](#node-buffer-fragments) | Port | Adapt Node Buffer construction and concatenation routines over typed arrays; delegate fill overload selection to the original typed adapter. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
