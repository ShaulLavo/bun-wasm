### Data format adapter

`crates/bunwasm-runtime/src/js/formats.ts`. Class **Host feature**, an **original adapter**. Comparison source is Bun `src/runtime/api/{JSON5Object,TOMLObject,YAMLObject}.rs` at `9510e74152073d850a18758ca41114d8f214ffa6`, not copied implementation. Parsing remains in Bun's Rust crates through `bunwasm-transpiler/src/data.rs`. The adapter hydrates that tagged graph, preserves shared references and exposes JavaScript serialization behavior. Strict TypeScript models the existing graph tags, key/value pairs, YAML aliases and Temporal operations. The native parse, byte-buffer and YAML coercion contracts are additive declarations in `runtime.d.ts`. The strict TypeScript conversion did not change parser or emitter behavior.

`formats_limit.ts` is an original size-only adapter, not copied upstream code.
Its error contract follows Bun's `src/runtime/api.rs` and
`test/js/bun/yaml/yaml.test.ts` at the same pin. After the existing conversion,
`formats.ts` checks the resulting view before `native.parseData`. The inclusive
maximum remains 2,147,483,647 bytes. Rejection now carries `RangeError`,
`ERR_OUT_OF_RANGE` and Bun's complete received-length message. A typed local
byte view replaces the conversion casts. The runtime-only Blob declaration
describes the existing `web.js` Blob `_bytes()` method, not the host DOM Blob.
Native parsing still requires `Uint8Array`; only the guard accepts a read-only
byte-length record. Bounded controls use synthetic lengths and at most
32-byte backing buffers. The original formats AST pin permits this explicit
functional delta and still detects unrelated edits. No new guest result is claimed.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-runtime/src/js/{formats,formats_limit}.ts`](#data-format-adapter) | Host feature | Original tagged-graph, serialization and input-length error adapters over Bun's Rust data parsers. |

[Parent context](bun-patch-series.md).
