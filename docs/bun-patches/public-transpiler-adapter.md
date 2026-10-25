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
| [Runtime project decorator config](#runtime-project-decorator-config) | Host feature | Original adapter passes Bun's project decorator flags into runtime TypeScript parsing. |

[Ledger scope and pinned revisions](scope.md).

## Runtime project decorator config

The runtime path in `crates/bunwasm-transpiler/src/lib.rs` is an original
adapter. For TypeScript modules, it walks source-directory ancestors and reads
each directory's config through Bun's `Resolver::read_dir_info_ignore_error` and
`DirInfo::tsconfig_json` before constructing `ParseOptions`. Bun's resolver
parses and merges the configuration. Its implementation is
`src/resolver/resolver.rs` at Bun revision
`9510e74152073d850a18758ca41114d8f214ffa6`, with the checked-in WASI patches.
No upstream implementation is copied or changed here.

Previously, only public `Bun.Transpiler` requests supplied decorator options.
Runtime TypeScript ignored the project's `experimentalDecorators` and
`emitDecoratorMetadata`, so NestJS received standard decorator arguments
instead of the legacy method descriptor. Project flags now reach the same
Bun parser. Public requests retain their explicit configuration, and plain
JavaScript does not run this lookup.
