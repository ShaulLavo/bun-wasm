# esbuild packet string allocation

## Classification and identity

`crates/bunwasm-runtime/src/esbuild_packet.rs` is a **Host feature**. Its
replacement fragments adapt `lib/shared/stdio_protocol.ts` from `evanw/esbuild`
tag `v0.25.12`, published in the MIT-licensed `esbuild-wasm@0.25.12`
`lib/main.js`. The original Rust qualification and replacement code is a
bun-wasm adapter. The compiled-check wrapper and TypeScript tests are original
bun-wasm controls. The existing unchanged protocol fixture and license are
recorded in [esbuild packet read diagnostic](esbuild-packet-diagnostic.md).

The adapter requires the entire published module's SHA-256,
`18b154677d0965c21748afe9b5f56fb11a664a9a6e21dd5fd5ecf9791384e700`, and a path
ending in `/node_modules/esbuild/lib/main.js` or
`/node_modules/esbuild-wasm/lib/main.js`. The first path covers the installer's
existing distribution alias. Nested installations qualify. Other paths,
versions, source changes, diagnostic copies, and already adapted modules stay
unchanged. The published tarball's SHA-256 is
`e0712c0e7a9bcfb53c648f63222b07d6ef052897da093498441b8ac5fcfc5342`.

Only path and source content affect qualification. No package manifest, binary,
or other filesystem input is read. The existing source-content cache dependency
is sufficient. The private module runs immediately after Oxc adaptation at the
existing pre-transpilation source boundary in `modules.rs`.

## Borrowed strings and owned bytes

The two string consumers, including object keys, call `read(false)`.
For a nonnegative in-bounds span in an ordinary Uint8Array backed by an
ArrayBuffer with its default constructor and species, this returns a temporary
subarray for synchronous UTF-8 decoding.
The real channel owns its stdout accumulator and reuses it only after packet
decoding returns. No borrowed byte value escapes in the decoded result.

The byte-value consumer still calls `read()` and receives an owned copy.
Buffers, shared buffers, and typed-array subclasses also retain the original
copy path. This preserves shared-buffer decoding and species behavior.

Negative lengths and out-of-bounds spans retain the original allocation before
the original bounds check. Signed length interpretation, allocation exceptions,
and truncated-input errors on that path stay unchanged. A valid string no
longer requires its temporary byte allocation, so refusal of that allocation
is deliberately avoided. UTF-8 decoding and its string allocation remain.

The replacement preserves every original line number. Columns change on the
three edited lines. There is no length cap, diagnostic, transport change,
engine-specific behavior, or dependency override.

## Reduced checks and limits

`scripts/esbuild-string-allocation.test.ts` downloads the pinned published
tarball, compiles the actual private Rust adapter, and executes both complete
module variants. It exercises their real encoder, decoder, and stdout channel
without launching an esbuild subprocess or compiling a guest.

The compressed fixture `scripts/fixtures/esbuild-packet/main.js.gz` preserves
the complete unchanged published module for the runtime unit test. It is
generated data with the upstream MIT license preserved beside it. Its decoded
bytes must equal the freshly downloaded module. The fixture is included only
under `cfg(test)`. The unit control calls the real `State::prepare_javascript`
path with the existing passthrough transpiler and requires the qualified file
to change while an unrelated path keeps the original source.

The checks cover allocation and copied-byte counts, Unicode and malformed
UTF-8, empty fields, packet headers, every truncated packet prefix, partial
stdout frames, accumulator reuse, caller mutation, typed-array offsets and
species, both UTF-8 implementations, and the original invalid-span failures.
An injected allocation refusal fails on the original valid string and succeeds
on the adapted decoder. The same refusal still fails for bytes.

The real encoder constructs response-shaped fixtures with repeated published
source text at 64 KiB, 1 MiB, 4 MiB, and 8 MiB. String-valued code avoids its
full byte copy plus 32 key bytes. Byte-valued code retains its full owned copy
and saves only those 32 key bytes. Each case keeps eight subarray views.
The test counts explicit typed-array backing allocations and `set` copies;
it does not measure engine-internal decoder work, physical memory, or peak RSS.

These generated fixtures are not captured framework packets. The historical
iPhone failure's requested field length and type remain unknown. This change
does not establish that field was a string, reproduce that failure, or qualify
a guest, framework, Safari, or iPhone execution.

`checks/web-esbuild-string-allocation.json` owns the reduced check under the
existing Web gate. The optional `BUNWASM_ESBUILD_STRING_RESULT` environment
variable writes measurements after test cleanup.

The actual `State::prepare_javascript` integration check is in the existing
`modules::tests::host_` group selected by the native quality gate. It decodes the
same exact-source fixture and checks both qualified and unrelated paths before
transpilation.
