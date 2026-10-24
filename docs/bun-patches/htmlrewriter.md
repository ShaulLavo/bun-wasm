## HTMLRewriter

Private handler registrations and synchronous output chunks append with a
captured `Object.defineProperty`, not indexed assignment through `push`.
An indexed accessor on `Array.prototype` therefore cannot intercept them.
This is an original storage fix, compared against Bun's
`test/js/workerd/html-rewriter-leak.test.ts` at pin
`9510e74152073d850a18758ca41114d8f214ffa6`. Lifetime abandonment is unchanged.

Class **Host feature**, **original adapters** in `crates/bunwasm-runtime/src/html_rewriter.rs`,
`src/js/html_rewriter.ts`, the native table and global registry.
The runtime links the unchanged `vendor/bun/vendor/lolhtml` Rust crate at Bun revision
`cd95fa7a13b3f13be73e512b38ec111c1c228084`. The vendored crate is lol-html 2.7.2,
including Bun's token suspension support. No vendor file changes.

Each transform owns a parser session. Content handlers suspend the parser and return a
plain-data event. TypeScript invokes the registered handler, waits for its promise for a
Response input, then resumes the parser. String and buffer inputs remain synchronous and
reject handlers that need asynchronous work. Response inputs consume the source reader
incrementally, keep the native-consumer reader lock after completion, forward cancellation
and preserve handler rejection values. Tokens and
attribute iterators detach when their handler ends. The wrapper is original bun-wasm code.
Bun's corresponding implementation, `src/runtime/api/html_rewriter.rs`, depends on Bun's
JSC-specific generated classes and stream sinks and cannot run through the builtin loader.

`third_party/licenses/lol-html-LICENSE` is copied unchanged from that vendored crate.


## Classification

| Patch or source | Class | Change |
| --- | --- | --- |
| [HTMLRewriter adapters and lol-html linkage](#htmlrewriter) | Host feature | Original parser sessions, async handler dispatch, private indexed storage and streaming wrappers on all engines. |
| [`third_party/licenses/lol-html-LICENSE`](#htmlrewriter) | Port | Retain the vendored parser's BSD license for wasm distribution. |
