## Public transpiler adapter

Class **Port**. `crates/bunwasm-transpiler/src/lib.rs` adapts the parse/print,
configuration and scan portions of Bun's `src/runtime/api/JSTranspiler.rs` at
`9510e74152073d850a18758ca41114d8f214ffa6`, with the exported WASI patches at
`cd95fa7a13b3f13be73e512b38ec111c1c228084`. Parsing, TypeScript lowering,
JSX, tsconfig parsing, import kinds and export names come from Bun's Rust crates.
The adapter removes JSC arguments, JS values, async task ownership and macro
contexts. Each public request owns its parser configuration and arena.

`src/js/bun_transpiler.ts`, the `Transpiler` trait method, CLI implementation
and native registration are original bun-wasm adapters. They validate JS input
and pass bytes and JSON options to the real parser. Public output is printed
without the module loader's source-preserving and async-context rewrites.
The async adapter snapshots the selected input bytes before deferring work.
Minification follows `Config::from_js` boolean/object normalization, and unused
import trimming explicitly defaults to the public API's tree-shaking setting.
This does not implement Bun's macro callbacks or worker-pool scheduling.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [Bun public transpiler adapter](#public-transpiler-adapter) | Port | Adapt the real Rust parse/print and scan paths to the engine-independent native boundary. |

[Ledger scope and pinned revisions](scope.md).
