# esbuild packet read diagnostic

Class **Host feature**. `scripts/fixtures/esbuild-packet/stdio-protocol.txt`
copies the unchanged protocol section of `esbuild-wasm@0.25.12`,
`package/lib/main.js`, from `function encodePacket` through `writeUInt32LE`.
Its upstream source is `evanw/esbuild` tag `v0.25.12`,
`lib/shared/stdio_protocol.ts`. The published module's SHA-256 is
`18b154677d0965c21748afe9b5f56fb11a664a9a6e21dd5fd5ecf9791384e700`.
The adjacent `LICENSE.txt` preserves the upstream MIT license.

The original adapter `scripts/esbuild-packet-diagnostic.ts` creates a
manual diagnostic copy of that module. It requires the complete unchanged
protocol section exactly once and refuses other source. It labels string,
byte and key reads, then reports only the first failed field read to stderr.
The single JSON line contains the signed length, unsigned wire value, payload
offset, remaining packet bytes, packet length, packet ID, request direction,
field kind, failure phase and whether the span fits. It retains no packet
content, decoded key, source text or error message.

Successful reads keep their original allocation, bounds-check and copy order.
The diagnostic rethrows the original error, including when reporting fails.
It adds scalar arguments and locals, a `try` block and phase assignments to
each field read. It adds no successful-read byte allocation or byte copy.
Formatting the first failure line allocates and can itself fail under memory
pressure. An absent line therefore does not exclude allocation failure.
Length-word read errors and errors outside field reads are not observed.

Nothing installs this adapter or selects it during an ordinary build.
Generate a separate output explicitly:

```sh
source env.sh
bun scripts/esbuild-packet-diagnostic.ts /path/to/esbuild/lib/main.js /work/tmp/esbuild-diagnostic.js
```

The CLI refuses to overwrite an existing output. A diagnostic capture must
explicitly arrange for the generated module to be the executed module. The
module's relative dependencies and package location must still resolve. This
tool does not arrange that capture, change installed dependencies, or replay
a framework.

`scripts/esbuild-packet-diagnostic.test.ts` executes the actual copied codec.
It covers valid values, UTF-8 byte lengths, every truncated packet prefix,
signed length words, allocation and bounds failures, byte-field ownership,
bounded reporting, error identity, source rejection and CLI file preservation.
The constructor sentinel is a test-only refusal, not an allocation cap.

The diagnostic does not establish the missing field length in the historical
TanStack failure. A failed allocation with `fits: false` selects invalid-span
handling. A nonnegative length with `fits: true` selects a legitimate field
allocation. Neither outcome alone identifies allocator pressure or corruption.
Returning packet views for byte fields would lose ownership when the stdout
accumulator is reused; the fixture verifies that current fields keep copies.
