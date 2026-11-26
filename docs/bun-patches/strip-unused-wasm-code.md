# Gate unreachable React Compiler and host-engine Wasmi out of Wasm guests

## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| `patches/bun/0027-wasm-gate-react_compiler-behind-a-cargo-feature-in-j.patch` (`vendor/bun/src/js_parser/`) | Port | Gate `bun_react_compiler` and its parser visit hooks behind an opt-in Cargo feature (`react-compiler`, off by default). |
| `crates/bunwasm-runtime/Cargo.toml`, `crates/bunwasm-runtime/src/lib.rs`, `crates/bunwasm-runtime/src/natives.rs` | Original adapter | Gate `wasmi`, `wasmparser`, `bunwasm-nested`, and the in-guest `wasm` native module behind the `engine-split` feature so `engine-host` (`dist/bun-browser.wasm`) omits them. |

## Upstream patch: `bun_js_parser` `react-compiler` feature

Upstream source: `oven-sh/bun` at pinned revision `a7733435cf40429e3b35c36072769df2052b80f1`:

- `src/js_parser/Cargo.toml`
- `src/js_parser/lib.rs`
- `src/js_parser/p.rs`
- `src/js_parser/parse/parse_entry.rs`
- `src/js_parser/parser.rs`
- `src/js_parser/visit/mod.rs`
- `src/js_parser/visit/visit_expr.rs`
- `src/js_parser/visit/visit_stmt.rs`

Local changes:
- Declare `default = []` and `react-compiler = ["dep:bun_react_compiler"]` in `src/js_parser/Cargo.toml` with `bun_react_compiler` marked `optional = true`.
- Guard `pub mod react_compiler_host`, the `P` react-compiler state fields, `JSXImportSymbols::tag_of`, and the parser/visitor hooks with `#[cfg(feature = "react-compiler")]`.

Reason:
- `bun-wasm` never enables the React Compiler in `bun`, `bun build`, or `Bun.Transpiler`: `crates/bunwasm-build/src/lib.rs` hardcodes `ReactCompilerMode::Disabled`, and `vendor/bun/src/js_parser/parser.rs` and `vendor/bun/src/bundler/options.rs` default it to `Disabled`. Only Bun's native JSC-tied `src/runtime/` crate ever enables it, and that crate is not built in `bun-wasm`.
- Unconditionally compiling `bun_react_compiler` through `bun_js_parser` added roughly 1.05 MB of unreachable Wasm code to `dist/bun.wasm`, `dist/bun-jsc.wasm`, and `dist/bun-browser.wasm`.
- `dist/bun-tools.wasm` (`bun lint`) still compiles `bun_react_compiler` directly via `bun_lint_react_compiler` (`vendor/bun/src/lint/react_compiler/Cargo.toml`) because `bun lint` runs React Compiler lint rules (`bun_react_compiler::lint_function`). It is left intact there.

## Original adapter: `engine-host` omits `wasmi`, `wasmparser`, and `bunwasm-nested`

`crates/bunwasm-runtime` only compiles `mod wasm` (and its optional `wasmi`, `wasmparser`, and `bunwasm-nested` dependencies) when `feature = "engine-split"` is enabled.

Reason:
- Every host that runs `dist/bun-browser.wasm` (`engine-host`) — browser Web Workers (Chromium, WebKit, Firefox) and the headless Node host (`web/scripts/node-host.ts` and test harnesses) — instantiates the guest using its own native `globalThis.WebAssembly`, and `web/src/engine-host.js` directly wraps `globalThis.WebAssembly` via `installNativeWasmLifetime`.
- `crates/bunwasm-runtime/src/js/bootstrap.js` skips `webassembly.ts` whenever `typeof globalThis.WebAssembly !== "undefined"`, and checks `native.wasm?.sharedMemorySupported?.()` with optional chaining. The `shared-group` profile that uses `bunwasm-nested` is an `engine-split` profile (`crates/bunwasm-cli/build.rs`).
- Keeping `wasmi`, `wasmparser`, and `bunwasm-nested` off `engine-host` removes about 868 KB of unreachable Wasm code from `dist/bun-browser.wasm`.

[Parent context](bun-patch-series.md).

[Ledger scope and pinned revisions](scope.md).
