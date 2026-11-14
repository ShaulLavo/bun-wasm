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

Raw encoding helper installation delegates to the original TypeScript adapter
documented in [Buffer encoding bindings](buffer-encoding-bindings.md). It keeps
the raw binding range and coercion policies separate from public `write` and
`toString` overload handling.

`fromArrayBuffer` preserves an omitted or undefined length when constructing
`FastBuffer`. Passing the computed remaining byte count instead creates a fixed
length typed-array view, which becomes out of bounds after a backing-store
shrink. Negative integer offsets now fail with `ERR_BUFFER_OUT_OF_BOUNDS`
before length coercion, while negative fractions that truncate to zero remain
valid. Native Bun 1.4.4 and Uint8Array controls confirm tracking through shrink,
regrow and growable shared storage, while explicit lengths remain fixed and all
views share the original storage. This is an original adapter correction, with
no newly copied upstream source. The regression fixture and production-factory
tests are `tests/fixtures/buffer-resizable-construction` and
`scripts/buffer-resizable-construction.test.ts`. They cover the three subprocess
programs at Bun `9510e74152073d850a18758ca41114d8f214ffa6`,
`test/js/node/buffer.test.js` lines 4415 and 4691, in the factory directly.
The encoding and ordinary ArrayBuffer constructor fixtures select QuickJS, JSC
and Browser. Every resizable ArrayBuffer assertion remains in the RAB fixture,
which selects QuickJS and Browser. The JSC WASI patch explicitly returns null
from `tryAllocateResizableMemory`, so RAB and GSAB construction fail before
Buffer is used. The full shared-growth assertion remains in the blocking
host/source controls. Those unavailable guest capabilities are not passing
coverage. No constructor probe, error catch or OOM suppression selects tests.


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
| [`crates/bunwasm-runtime/src/js/buffer.js`](#node-buffer-fragments) | Port | Adapt Node Buffer construction and concatenation routines over typed arrays; preserve omitted-length tracking and empty-copy range ordering, delegate fill overload selection to the original typed adapter, and re-export the shared web `Blob`/`File` constructors without wrapping them. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
