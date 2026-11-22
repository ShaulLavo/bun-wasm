### Node Buffer fragments

`crates/bunwasm-runtime/src/js/buffer.js`. Class **Port**. Comparison sources are Node `lib/buffer.js` at the Node comparison revision, plus Bun `src/js/builtins/JSBufferConstructor.ts` and `src/node-fallbacks/buffer.js` at the Bun pin. The direct Node import revision is not recorded.

Retain recognizable Buffer constructor dispatch, `fromObject` array-like handling, and concatenation fragments. Adapt the FastBuffer pattern to locally allocated `Uint8Array` storage without Node's native binding, unsafe allocator, or pool. Local codecs, `DataView` numeric access, validation helpers, and factory wiring provide the remaining implementation. `copyBytesFrom` validates the view first and returns an empty Buffer for an empty view before checking either range argument. For nonempty views it validates the offset, returns empty at or past the end, then validates the length before slicing. This ordering is an original adapter correction checked against native Bun 1.4.4 and Node 26.12.1, not a newly copied upstream implementation. Negative and fractional ranges still throw when their validation is reached. This is a mixed file with adapted routines, not an unmodified copy of Node's entire Buffer module.

The `Blob` and `File` exports are original bun-wasm wiring, not copied upstream code.

The public `inspect()` method formats the real byte view directly, ignoring
custom inspection hooks and rejecting invalid receivers. Numeric accessors use
intrinsic view getters rather than shadowable backing properties and validate an offset's type before
the receiver, retain element-count bounds for wider typed-array receivers, and
read or write their underlying bytes. One-byte writers check the offset's type
before the value range; wider writers preserve value-first validation. Variable
width writers require an offset while fixed-width writers default it to zero.
`Buffer.concat` captures every input getter once, validates all resulting views
including detached views, then measures their current lengths. A later getter
can shrink an earlier resizable view without leaving an oversized result. These
are original adapter corrections against unchanged Bun tests at
`9510e74152073d850a18758ca41114d8f214ffa6` and native Bun 1.4.4 and Node 26.12.1.
The new transcoding adapter has its own [record](buffer-transcode.md).
`tests/fixtures/buffer-concat-resizable` keeps the shrink assertions mandatory
on QuickJS, Browser, SpiderMonkey and JSC, which has a [malloc resizable
backing](jsc-resizable-backing.md). It uses no capability probe or caught OOM to pass.
`web.js` creates the shared constructors in `internal.web` and installs those same
references as globals; the Buffer factory now re-exports those exact references. This
preserves constructor identity across global, CommonJS, and named/default ESM access, so
`class extends` and `super` use the existing web prototypes rather than a wrapper or a
second class. The `internal.web &&` guard keeps isolated Buffer-factory setup valid
before web initialization. This is a browser-target Port change motivated by the
Node/Bun-compatible export contract, with no new Blob or File implementation copied
from upstream.

The `resolveObjectURL` export delegates to the shared original registry described
in [URL errors and object URLs](url-errors-object-urls.md). This export is the
only Buffer implementation change for that adapter.

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
which selects QuickJS, Browser and JSC; JSC backs resizable ArrayBuffers with
[malloc memory](jsc-resizable-backing.md). JSC on WASI still refuses growable
SharedArrayBuffers ([record](wasi-resizable-buffer-allocation.md)), so GSAB
construction fails there before Buffer is used. The full shared-growth assertion
remains in the blocking host/source controls. That unavailable guest capability
is not passing coverage. No constructor probe, error catch or OOM suppression selects tests.


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

The residual argument and search corrections are original adapter changes,
checked against unchanged `test/js/node/buffer.test.js` and
`test/js/node/buffer-concat.test.ts` at Bun
`9510e74152073d850a18758ca41114d8f214ffa6`, plus native Bun 1.4.4 controls.
`buffer_fill_args.ts` only selects encoding overloads for string fill values.
An omitted start ignores the end for every value, and string encodings are
validated before an empty-range return without encoding the fill value.
Unrecognized string encodings receive `ERR_UNKNOWN_ENCODING`; unrecognized
non-string encodings receive `ERR_INVALID_ARG_TYPE`. Object conversion errors
still propagate.
The public `toString` gate rejects an explicit empty encoding independently of
fill's default encoding policy.

UTF-16 search compares complete two-byte units at aligned positions, retaining
the raw needle length for bounds checks. Buffer needles wrap a negative offset
against the original byte length; string needles wrap against the even search
length. An empty needle returns a clamped byte offset. The common numeric
offset check distinguishes NaN and fractions from infinities, which receive
the bounds error. `toLocaleString` references the exact `toString` function.
Public prototype methods are enumerable, as in native Bun and Node, allowing
instance mocks to discover and replace them through `for...in`.
The maintained small-buffer checks are
`tests/fixtures/buffer-residual-semantics` and
`scripts/buffer-residual-semantics.test.ts`. They require no private hooks or
large allocations and preserve the existing raw encoding binding tests.


`buffer_concat_length.ts` is an original allocation-boundary adapter, using
Bun `src/jsc/bindings/JSBuffer.cpp` at
`9510e74152073d850a18758ca41114d8f214ffa6` as its comparison source.
An inferred concatenation length beyond `constants.MAX_LENGTH` raises Bun's
typed-array allocation-limit error. Explicit lengths still use the existing
`length` argument validation, and allocation methods retain their `size`
validation. Native Bun 1.4.4 confirms those separate errors.

`isAscii` and `isUtf8` are callable without being constructible, and have no
`prototype`, matching native Bun 1.4.4.
The unchanged upstream `new isAscii(...)` expectation of primitive `false`
still fails; the native oracle rejects construction with TypeError. The adapter
does not alter that upstream expectation or pretend it passes.

`scripts/buffer-allocation-boundaries.test.ts` loads the production factories.
`tests/fixtures/buffer-allocation-boundaries` checks the public functions across
QuickJS, JSC, Browser and SpiderMonkey, using one 64 MiB input repeated by
reference for the oversized concatenation.

`fillImpl` and `bidirectionalIndexOf` delegate argument/view coercion to the
TypeScript helpers in `buffer_fill_args.ts`: `fillImpl` captures the
pre-coercion intrinsic byte length for `end` validation, clamps the live range
after encoding coercion before decoding string patterns or rejecting
empty/detached `ArrayBufferView` patterns with Bun's `ERR_INVALID_ARG_VALUE`
("Buffer cannot be empty"), and re-clamps after non-string `value` coercion.
`bidirectionalIndexOf` captures the pre-coercion length for `lastIndexOf`'s
default reverse offset, converts `encoding` once via ordinary string coercion
(rejecting `Symbol` values), reads live intrinsic lengths before searching, and
only inspects `.buffer.detached` when searching an empty needle in a
zero-length haystack so nonempty searches keep the `.buffer` getter off the
common path. Both are original adapter corrections against Bun
`test/js/node/buffer-copy-fill-detach.test.ts` and
`test/js/node/buffer-indexOf-detach.test.ts`, covered in
`tests/fixtures/buffer-residual-semantics`.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/buffer.js`](#node-buffer-fragments) | Port | Adapt Node Buffer construction and concatenation routines over typed arrays; preserve omitted-length tracking and empty-copy range ordering, delegate fill overload selection to the original typed adapter, and re-export the shared web `Blob`/`File` constructors without wrapping them. |
| `crates/bunwasm-runtime/src/js/buffer_concat_length.ts` | Original adapter | Preserve Bun's allocation-limit error for an inferred concatenation length. |

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
