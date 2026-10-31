### Node Buffer fragments

`crates/bunwasm-runtime/src/js/buffer.js`. Class **Port**. Comparison sources are Node `lib/buffer.js` at the Node comparison revision, plus Bun `src/js/builtins/JSBufferConstructor.ts` and `src/node-fallbacks/buffer.js` at the Bun pin. The direct Node import revision is not recorded.

Retain recognizable Buffer constructor dispatch, `fromObject` array-like handling, and concatenation fragments. Adapt the FastBuffer pattern to locally allocated `Uint8Array` storage without Node's native binding, unsafe allocator, or pool. Local codecs, `DataView` numeric access, validation helpers, and factory wiring provide the remaining implementation. `copyBytesFrom` validates the view first and returns an empty Buffer for an empty view before checking either range argument. For nonempty views it validates the offset, returns empty at or past the end, then validates the length before slicing. This ordering is an original adapter correction checked against native Bun 1.4.4 and Node 26.12.1, not a newly copied upstream implementation. Negative and fractional ranges still throw when their validation is reached. This is a mixed file with adapted routines, not an unmodified copy of Node's entire Buffer module.

The `Blob` and `File` exports are original bun-wasm wiring, not copied upstream code.
`web.js` creates the shared constructors in `internal.web` and installs those same
references as globals; the Buffer factory now re-exports those exact references. This
preserves constructor identity across global, CommonJS, and named/default ESM access, so
`class extends` and `super` use the existing web prototypes rather than a wrapper or a
second class. The `internal.web &&` guard keeps isolated Buffer-factory setup valid
before web initialization. This is a browser-target Port change motivated by the
Node/Bun-compatible export contract, with no new Blob or File implementation copied
from upstream.


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
| [`crates/bunwasm-runtime/src/js/buffer.js`](#node-buffer-fragments) | Port | Adapt Node Buffer construction and concatenation routines over typed arrays; preserve native empty-copy range ordering, delegate fill overload selection to the original typed adapter, and re-export the shared web `Blob`/`File` constructors without wrapping them. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
