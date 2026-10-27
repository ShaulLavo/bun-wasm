## 0012 WASI lint rule docs

Class **Port**. Upstream `src/lint/driver/{Cargo.toml,explain.rs}` at Bun
revision `9510e74152073d850a18758ca41114d8f214ffa6`, with an original WASI
build adapter in `src/lint/driver/build.rs`.

Bun's ordinary debug embedding mode reads `lint-rule-pages.txt` from a path
on the build machine. `bun lint --rules` reproduced a panic when that path was
not preopened in WASI. For the WASI target, the adapter runs Bun's unchanged
`src/codegen/generate-lint-docs.ts` and `compress-embed.ts` over its existing
`docs/lint/rules` pages. It writes both outputs into Cargo's owned `OUT_DIR`.
The WASI arm in `explain.rs` embeds the compressed output and inflates it with
Bun's existing `bun_zstd::inflate_embedded`, like its normal release build.
Native Bun's code generation and embedding behavior is unchanged.

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [0012](#0012-wasi-lint-rule-docs) | Port | Generate and embed Bun's compressed lint rule docs in WASI artifacts. |

[Ledger scope and pinned revisions](scope.md).
