### Copied and generated Bun source

`crates/bunwasm-glue/src/bun_native.rs` copies the pinned Bun file `src/sema/standalone/native.rs`. Class **Port**. Its only implementation changes supply base64 length, encode, strict decode, and lenient decode functions and a working `compress2` backed by `miniz_oxide`. The standalone parser intentionally leaves these as stubs. Without replacements wasm bundling paths that need base64 or compression fail. This does not repair the native Bun implementations, which link their real libraries.

All Bun paths in the following sections refer to `oven-sh/bun` at `9510e74152073d850a18758ca41114d8f214ffa6`, the pin above. This includes Node implementations carried in Bun's tree. Bun's original MIT source and its inherited Node and better-sqlite3 code retain their respective upstream provenance.

For direct Node ports, the historical import revision is **not recorded** in the source headers or introducing commit `45671e47b114b16d5953d3ebecee1fbebf2678b5`. The audit compares them with [`nodejs/node` v22.20.0, `caa20e28dc1f21a97f7b2a7134973fd6435b65f0`](https://github.com/nodejs/node/tree/caa20e28dc1f21a97f7b2a7134973fd6435b65f0). That is a reproducible comparison revision, not a claim about the original import. Recognizable adapted fragments are included even when their headers do not declare a port.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [`crates/bunwasm-glue/src/bun_native.rs`](#copied-and-generated-bun-source) | Port | Replace standalone parser base64 and zlib stubs with working Rust implementations. |

[Parent context](bun-patch-series.md).
